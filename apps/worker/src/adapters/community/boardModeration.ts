import { boardReportRetentionCutoff } from "@tetraboard/context-community";
import type { BoardAdminReport, BoardModeration } from "@tetraboard/protocol/board";
import { accountNotDeletedSql } from "../../db/deletionGuard";
import { boardPublishedSql } from "./boardRows";

type ReportRow = Omit<BoardAdminReport, "postDeleted" | "authorStopped" | "authorWithdrawn"> & {
  postDeleted: number;
  authorStopped: number;
  authorWithdrawn: number;
};

export async function readBoardModeration(db: D1Database, now: number) {
  const [settings, reports, stoppedSenders] = await db.batch([
    db.prepare("SELECT accepting FROM board_settings WHERE id=1"),
    db
      .prepare(`SELECT r.id,r.post_id AS postId,r.parent_id AS parentId,r.game_id AS gameId,r.reason,
 CASE WHEN d.id IS NOT NULL THEN '退会したプレイヤー' ELSE r.author_name END AS authorName,
 r.body AS text,r.posted_at_ms AS postedAtMs,r.reported_at_ms AS reportedAtMs,r.status,
 (SELECT COUNT(*) FROM board_reports other WHERE other.post_id=r.post_id AND other.reported_at_ms>?1) AS reportCount,
 (p.id IS NULL OR NOT (${boardPublishedSql("p")})) AS postDeleted,
 (d.id IS NULL AND COALESCE(s.stopped,0)=1) AS authorStopped,
 (d.id IS NOT NULL OR r.author_account_id IS NULL) AS authorWithdrawn
 FROM board_reports r LEFT JOIN board_posts p ON p.id=r.post_id
 LEFT JOIN deleted_accounts d ON d.id=r.author_account_id
 LEFT JOIN board_senders s ON s.account_id=r.author_account_id
 WHERE r.reported_at_ms>?1 ORDER BY r.reported_at_ms DESC,r.id DESC LIMIT 500`)
      .bind(boardReportRetentionCutoff(now)),
    db.prepare(`SELECT s.account_id AS accountId,u.name FROM board_senders s JOIN user u ON u.id=s.account_id
 WHERE s.stopped=1 AND ${accountNotDeletedSql("u.id")} ORDER BY u.name,u.id`),
  ]);
  const state = settings!.results[0] as { accepting: number } | undefined;
  return {
    acceptingPosts: Boolean(state?.accepting),
    reports: (reports!.results as ReportRow[]).map((row) => ({
      ...row,
      postDeleted: Boolean(row.postDeleted),
      authorStopped: Boolean(row.authorStopped),
      authorWithdrawn: Boolean(row.authorWithdrawn),
    })),
    stoppedSenders: stoppedSenders!.results,
  };
}

async function deleteBoardPost(db: D1Database, postId: string, now: number) {
  const [, existing] = await db.batch([
    db
      .prepare(`UPDATE board_posts SET body=NULL,match_id=NULL,position=NULL,deleted_at_ms=?,
 deletion_reason='moderator' WHERE id=? AND deleted_at_ms IS NULL`)
      .bind(now, postId),
    db.prepare("SELECT id FROM board_posts WHERE id=?").bind(postId),
  ]);
  return existing!.results.length === 1;
}

export async function moderateBoard(db: D1Database, input: BoardModeration, now: number) {
  switch (input.action) {
    case "delete":
      return deleteBoardPost(db, input.postId, now);
    case "stop": {
      const result = await db
        .prepare(`INSERT INTO board_senders(account_id,stopped)
 SELECT p.account_id,? FROM board_posts p
 WHERE p.id=? AND p.account_id IS NOT NULL AND ${accountNotDeletedSql("p.account_id")}
 ON CONFLICT(account_id) DO UPDATE SET stopped=excluded.stopped`)
        .bind(Number(input.stopped), input.postId)
        .run();
      return Boolean(result.meta.changes);
    }
    case "unstop":
      await db
        .prepare("UPDATE board_senders SET stopped=0 WHERE account_id=?")
        .bind(input.accountId)
        .run();
      break;
    case "accepting":
      await db
        .prepare("UPDATE board_settings SET accepting=? WHERE id=1")
        .bind(Number(input.accepting))
        .run();
      break;
    case "resolve":
      await db
        .prepare("UPDATE board_reports SET status='resolved' WHERE id=? AND reported_at_ms>?")
        .bind(input.reportId, boardReportRetentionCutoff(now))
        .run();
      break;
  }
  return true;
}
