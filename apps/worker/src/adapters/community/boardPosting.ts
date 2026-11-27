import {
  boardWriteRejection,
  type BoardWriteAttempt,
  type BoardWriteResult,
  type BoardWriteState,
  type BoardWriter,
} from "@tetraboard/context-community";
import type { BoardAttachment } from "@tetraboard/protocol/board";
import type { GameId } from "@tetraboard/protocol/games";
import { accountNotDeletedSql } from "../../db/deletionGuard";
import { boardPostingStateColumns, boardSenderJoin } from "./boardReads";
import {
  boardPost,
  boardPostColumns,
  boardPostFrom,
  boardPublishedSql,
  boardReply,
  type BoardRow,
} from "./boardRows";

export const boardAccountEligibleSql = `u.profileCompleted=1 AND COALESCE(u.isAnonymous,0)=0
 AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=u.id)`;

export const boardEligibleAccountExistsSql = `EXISTS(SELECT 1 FROM user u
 WHERE u.id=?1 AND ${boardAccountEligibleSql} AND ${accountNotDeletedSql("u.id")})`;

const liveParentSql = `parent.parent_id IS NULL AND ${boardPublishedSql("parent")}`;

function ensureBoardSender(db: D1Database, accountId: string) {
  return db
    .prepare(`INSERT INTO board_senders(account_id) SELECT u.id FROM user u
 WHERE u.id=?1 AND ${boardAccountEligibleSql} AND ${accountNotDeletedSql("u.id")}
 ON CONFLICT(account_id) DO NOTHING`)
    .bind(accountId);
}

function insertPost(db: D1Database, attempt: BoardWriteAttempt, id: string, lastPostByMs: number) {
  return db
    .prepare(`INSERT INTO board_posts(id,game_id,parent_id,account_id,body,posted_at_ms,request_id,body_hash,match_id,position)
 SELECT ?2,COALESCE(?3,parent.game_id),?4,u.id,?5,?6,?7,?8,?10,?11
 FROM user u JOIN board_senders s ON s.account_id=u.id
 LEFT JOIN board_posts parent ON parent.id=?4 AND ${liveParentSql}
 WHERE u.id=?1 AND ${boardAccountEligibleSql} AND ${accountNotDeletedSql("u.id")}
 AND s.stopped=0 AND (s.last_posted_at_ms=0 OR s.last_posted_at_ms<=?9)
 AND (SELECT accepting FROM board_settings WHERE id=1)=1 AND (?4 IS NULL OR parent.id IS NOT NULL)
 ON CONFLICT(account_id,request_id) DO NOTHING`)
    .bind(
      attempt.accountId,
      id,
      attempt.gameId,
      attempt.parentId,
      attempt.text,
      attempt.postedAtMs,
      attempt.requestId,
      attempt.bodyHash,
      lastPostByMs,
      attempt.attachment?.matchId ?? null,
      attempt.attachment?.position ?? null,
    );
}

function replayStatement(db: D1Database, accountId: string, requestId: string) {
  return db
    .prepare(`SELECT p.body_hash AS bodyHash,${boardPostColumns} ${boardPostFrom}
 WHERE p.account_id=?1 AND p.request_id=?2 AND p.body_hash IS NOT NULL AND ${boardEligibleAccountExistsSql}`)
    .bind(accountId, requestId);
}

function rejectionStatement(db: D1Database, accountId: string, parentId: string | null) {
  return db
    .prepare(`SELECT ${boardPostingStateColumns},${boardEligibleAccountExistsSql} AS eligible,
 (?2 IS NULL OR parent.id IS NOT NULL) AS parentAvailable, parent.game_id AS parentGameId
 ${boardSenderJoin} LEFT JOIN board_posts parent ON parent.id=?2 AND ${liveParentSql}`)
    .bind(accountId, parentId);
}

type BoardWriteStateRow = BoardWriteState & { parentGameId: GameId | null };
type BoardReplayRow = BoardRow & { bodyHash: string };

export class D1BoardWriter implements BoardWriter {
  constructor(
    private readonly db: D1Database,
    private readonly canAttach: (game: GameId, attachment: BoardAttachment) => Promise<boolean>,
  ) {}

  async insertEligiblePost(
    attempt: BoardWriteAttempt,
    lastPostByMs: number,
  ): Promise<BoardWriteResult> {
    const { db } = this;
    const { accountId, requestId, parentId, postedAtMs, attachment } = attempt;
    const replayQuery = replayStatement(db, accountId, requestId);
    const rejectionQuery = rejectionStatement(db, accountId, parentId);
    if (attachment) {
      // 棋譜を取得する前に再送と既存の拒否条件を確かめます。
      const [replay, checked] = await db.batch([replayQuery, rejectionQuery]);
      const existing = replay!.results[0] as BoardReplayRow | undefined;
      if (existing) return { accepted: acceptedPost(existing, accountId) };
      const rejection = checked!.results[0] as BoardWriteStateRow;
      if (boardWriteRejection(rejection, lastPostByMs))
        return { accepted: null, rejection, invalidAttachment: false };
      const game = attempt.gameId ?? rejection.parentGameId;
      if (game === null) throw new Error("Missing board parent game");
      if (!(await this.canAttach(game, attachment))) {
        const [replay, rejection] = await db.batch([replayQuery, rejectionQuery]);
        return writeResult(replay!, rejection!, accountId, true);
      }
    }
    const id = crypto.randomUUID();
    // 投稿と投稿時刻を同じ batch で確定し、再送の内容もその時点の状態から返します。
    const [, , , replay, rejection] = await db.batch([
      ensureBoardSender(db, accountId),
      insertPost(db, attempt, id, lastPostByMs),
      db
        .prepare(`UPDATE board_senders SET last_posted_at_ms=? WHERE account_id=?
 AND EXISTS(SELECT 1 FROM board_posts WHERE id=?)`)
        .bind(postedAtMs, accountId, id),
      replayQuery,
      rejectionQuery,
    ]);
    return writeResult(replay!, rejection!, accountId, false);
  }
}

function writeResult(
  replay: D1Result,
  rejection: D1Result,
  accountId: string,
  invalidAttachment: boolean,
): BoardWriteResult {
  const row = replay.results[0] as BoardReplayRow | undefined;
  return row
    ? { accepted: acceptedPost(row, accountId) }
    : {
        accepted: null,
        rejection: rejection.results[0] as BoardWriteStateRow,
        invalidAttachment,
      };
}

function acceptedPost(row: BoardReplayRow, viewer: string) {
  const { bodyHash, gameId, parentId, postedAtMs } = row;
  const post = parentId === null ? boardPost(row, viewer) : null;
  return {
    bodyHash,
    gameId,
    parentId,
    postedAtMs,
    post: post?.status === "published" ? post : null,
    reply: parentId !== null && row.deletedAtMs === null ? boardReply(row, viewer) : null,
  };
}
