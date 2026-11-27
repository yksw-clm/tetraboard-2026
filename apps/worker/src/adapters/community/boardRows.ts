import { boardPostVisibility } from "@tetraboard/context-community";
import type { BoardPost, BoardReply } from "@tetraboard/protocol/board";
import type { GameId } from "@tetraboard/protocol/games";
import { accountNotDeletedSql } from "../../db/deletionGuard";
import { accountAvatarUrl } from "../account/profilePolicy";

export const boardPublishedSql = (alias: string) =>
  `${alias}.deleted_at_ms IS NULL AND ${accountNotDeletedSql(`${alias}.account_id`)}`;

export const boardLiveRepliesSql = `FROM board_posts r WHERE r.parent_id=p.id AND ${boardPublishedSql("r")}`;

const boardLikesSql = `FROM board_likes l WHERE l.post_id=p.id AND ${accountNotDeletedSql("l.account_id")}`;
export const boardLikeColumns = `
 (SELECT COUNT(*) ${boardLikesSql}) AS likeCount,
 EXISTS(SELECT 1 ${boardLikesSql} AND l.account_id=?1) AS liked`;

export const boardPostColumns = `p.id,n.number AS publicNumber,p.game_id AS gameId,p.parent_id AS parentId,
 p.posted_at_ms AS postedAtMs,COALESCE(p.deleted_at_ms,d.requested_at_ms) AS deletedAtMs,
 CASE WHEN u.id IS NOT NULL THEN p.body END AS text,
 CASE WHEN u.id IS NOT NULL THEN p.match_id END AS matchId,
 CASE WHEN u.id IS NOT NULL THEN p.position END AS position,
 u.id AS accountId,u.name,u.avatarKey,u.avatarPresetId,u.publicProfileId,
 (SELECT COUNT(*) ${boardLiveRepliesSql}) AS replyCount,${boardLikeColumns}`;

export const boardPostFrom = `FROM board_posts p LEFT JOIN board_post_numbers n ON n.post_id=p.id
 LEFT JOIN deleted_accounts d ON d.id=p.account_id
 LEFT JOIN user u ON u.id=p.account_id AND p.deleted_at_ms IS NULL AND d.id IS NULL`;

export type BoardRow = {
  id: string;
  publicNumber: number | null;
  gameId: GameId;
  parentId: string | null;
  postedAtMs: number;
  deletedAtMs: number | null;
  replyCount: number;
  text: string | null;
  matchId: string | null;
  position: number | null;
  accountId: string | null;
  name: string | null;
  avatarKey: string | null;
  avatarPresetId: string | null;
  publicProfileId: string | null;
  likeCount: number;
  liked: number;
};

export function boardReply(row: BoardRow, viewer: string | null): BoardReply {
  const { id, postedAtMs, text, accountId, name, avatarKey, avatarPresetId, publicProfileId } = row;
  if (text === null || accountId === null || name === null) throw new Error("Missing board author");
  return {
    id,
    postedAtMs,
    text,
    attachment:
      row.matchId !== null && row.position !== null
        ? { matchId: row.matchId, position: row.position }
        : null,
    author: {
      name,
      avatarUrl: accountAvatarUrl({ id: accountId, avatarKey, avatarPresetId }),
      profileTarget: publicProfileId ? { source: "profile", profileId: publicProfileId } : null,
    },
    likeCount: row.likeCount,
    liked: Boolean(row.liked),
    own: accountId === viewer,
  };
}

export function boardPost(row: BoardRow, viewer: string | null): BoardPost | null {
  const { id, publicNumber, gameId, postedAtMs, replyCount } = row;
  const visibility = boardPostVisibility(row.deletedAtMs, replyCount);
  if (visibility === "notFound") return null;
  if (publicNumber === null) throw new Error("Missing board post number");
  return visibility === "placeholder"
    ? { status: "deleted", id, publicNumber, gameId, postedAtMs, replyCount }
    : { status: "published", ...boardReply(row, viewer), publicNumber, gameId, replyCount };
}
