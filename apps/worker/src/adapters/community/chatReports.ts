import type { ChatReport, ChatReportAttempt, ChatReportStore } from "@tetraboard/context-community";

export class D1ChatReports implements ChatReportStore {
  constructor(private readonly db: D1Database) {}

  async insertWithinLimit({
    accountId,
    messageId,
    tournamentId,
    reportedAtMs,
    retentionCutoffMs,
    rateLimitCutoffMs,
    rateLimit,
  }: ChatReportAttempt) {
    const result = await this.db
      .prepare(`INSERT OR IGNORE INTO lobby_chat_reports(id,message_id,sender_account_id,sender_public_id,sender_name,body,sent_at_ms,reporter_account_id,reported_at_ms,tournament_id)
 SELECT ?,m.id,m.account_id,COALESCE(m.sender_public_id,s.public_id),u.name,m.body,m.sent_at_ms,?,?,m.tournament_id
 FROM lobby_chat_messages m JOIN user u ON u.id=m.account_id JOIN lobby_chat_senders s ON s.account_id=u.id
 WHERE m.id=? AND m.tournament_id IS ? AND m.sent_at_ms>? AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id IN(m.account_id,?))
 AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=?)
 AND (SELECT COUNT(*) FROM lobby_chat_reports WHERE reporter_account_id=? AND reported_at_ms>?)<?`)
      .bind(
        crypto.randomUUID(),
        accountId,
        reportedAtMs,
        messageId,
        tournamentId,
        retentionCutoffMs,
        accountId,
        accountId,
        accountId,
        rateLimitCutoffMs,
        rateLimit,
      )
      .run();
    return Boolean(result.meta.changes);
  }

  async hasReportSince({ accountId, messageId, tournamentId }: ChatReport, cutoffMs: number) {
    const existing = await this.db
      .prepare(
        "SELECT id FROM lobby_chat_reports WHERE message_id=? AND reporter_account_id=? AND reported_at_ms>? AND tournament_id IS ?",
      )
      .bind(messageId, accountId, cutoffMs, tournamentId)
      .first();
    return existing !== null;
  }
}
