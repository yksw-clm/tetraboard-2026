import type {
  BoardReport,
  BoardReportAttempt,
  BoardReportStore,
} from "@tetraboard/context-community";
import { accountNotDeletedSql } from "../../db/deletionGuard";
import { boardPublishedSql } from "./boardRows";

const reporterNotMerged = "NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=?1)";

export class D1BoardReports implements BoardReportStore {
  constructor(private readonly db: D1Database) {}

  async insertWithinLimit(attempt: BoardReportAttempt) {
    const result = await this.db
      .prepare(`INSERT INTO board_reports(
 id,post_id,game_id,parent_id,author_account_id,author_name,body,posted_at_ms,reason,reporter_account_id,reported_at_ms)
 SELECT ?3,p.id,p.game_id,p.parent_id,p.account_id,u.name,p.body,p.posted_at_ms,?4,?1,?5
 FROM board_posts p JOIN user u ON u.id=p.account_id
 WHERE p.id=?2 AND ${boardPublishedSql("p")} AND ${accountNotDeletedSql("?1")} AND ${reporterNotMerged}
 AND (SELECT COUNT(*) FROM board_reports WHERE reporter_account_id=?1 AND reported_at_ms>?6)<?7
 ON CONFLICT(post_id,reporter_account_id) DO UPDATE SET
 id=excluded.id,game_id=excluded.game_id,parent_id=excluded.parent_id,
 author_account_id=excluded.author_account_id,author_name=excluded.author_name,body=excluded.body,
 posted_at_ms=excluded.posted_at_ms,reason=excluded.reason,reported_at_ms=excluded.reported_at_ms,status='open'
 WHERE board_reports.reported_at_ms<=?8`)
      .bind(
        attempt.accountId,
        attempt.postId,
        crypto.randomUUID(),
        attempt.reason,
        attempt.reportedAtMs,
        attempt.rateLimitCutoffMs,
        attempt.rateLimit,
        attempt.retentionCutoffMs,
      )
      .run();
    return Boolean(result.meta.changes);
  }

  async hasReportSince({ accountId, postId }: BoardReport, cutoffMs: number) {
    const existing = await this.db
      .prepare(`SELECT r.id FROM board_reports r
 JOIN board_posts p ON p.id=r.post_id
 JOIN user u ON u.id=p.account_id
 WHERE r.reporter_account_id=?1 AND r.post_id=?2 AND r.reported_at_ms>?3
 AND ${boardPublishedSql("p")} AND ${accountNotDeletedSql("?1")} AND ${reporterNotMerged}`)
      .bind(accountId, postId, cutoffMs)
      .first();
    return existing !== null;
  }
}
