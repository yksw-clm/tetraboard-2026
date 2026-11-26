import type {
  BoardWriteAttempt,
  BoardWriteResult,
  BoardWriter,
} from "@tetraboard/context-community";
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
    .prepare(`INSERT INTO board_posts(id,game_id,parent_id,account_id,body,posted_at_ms,request_id,body_hash)
 SELECT ?2,COALESCE(?3,parent.game_id),?4,u.id,?5,?6,?7,?8
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
    );
}

function replayStatement(db: D1Database, accountId: string, requestId: string) {
  return db
    .prepare(`SELECT p.body_hash AS bodyHash,${boardPostColumns} ${boardPostFrom}
 WHERE p.account_id=?1 AND p.request_id=?2 AND ${boardEligibleAccountExistsSql}`)
    .bind(accountId, requestId);
}

function rejectionStatement(db: D1Database, accountId: string, parentId: string | null) {
  return db
    .prepare(`SELECT ${boardPostingStateColumns},${boardEligibleAccountExistsSql} AS eligible,
 (?2 IS NULL OR EXISTS(SELECT 1 FROM board_posts parent WHERE parent.id=?2 AND ${liveParentSql}))
 AS parentAvailable ${boardSenderJoin}`)
    .bind(accountId, parentId);
}

export class D1BoardWriter implements BoardWriter {
  constructor(private readonly db: D1Database) {}

  async insertEligiblePost(
    attempt: BoardWriteAttempt,
    lastPostByMs: number,
  ): Promise<BoardWriteResult> {
    const { db } = this;
    const { accountId, requestId, parentId, postedAtMs } = attempt;
    const id = crypto.randomUUID();
    // 投稿と投稿時刻を同じ batch で確定し、再送の内容もその時点の状態から返します。
    const [, , , replay, rejection] = await db.batch([
      ensureBoardSender(db, accountId),
      insertPost(db, attempt, id, lastPostByMs),
      db
        .prepare(`UPDATE board_senders SET last_posted_at_ms=? WHERE account_id=?
 AND EXISTS(SELECT 1 FROM board_posts WHERE id=?)`)
        .bind(postedAtMs, accountId, id),
      replayStatement(db, accountId, requestId),
      rejectionStatement(db, accountId, parentId),
    ]);
    const row = replay!.results[0] as (BoardRow & { bodyHash: string }) | undefined;
    return {
      accepted: row ? acceptedPost(row, accountId) : null,
      rejection: rejection!.results[0] as BoardWriteResult["rejection"],
    };
  }
}

function acceptedPost(row: BoardRow & { bodyHash: string }, viewer: string) {
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
