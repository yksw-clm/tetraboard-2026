import {
  submitRoomReport,
  type ReportListStore,
  type ReportSubmission,
  type ReportSubmissionStore,
} from "@tetraboard/context-community";
import { moderationReportSchema, type ModerationReport } from "@tetraboard/protocol";

type ReportRow = {
  id: string;
  room_id: string;
  instance_id: string;
  message_id: string;
  sender_id: string;
  sender_name: string;
  body: string;
  sent_at_ms: number;
  reporter_hash: string;
  reported_at_ms: number;
  expires_at_ms: number;
  status: string;
  action: string | null;
};

function toReport(row: ReportRow): ModerationReport {
  return moderationReportSchema.parse({
    id: row.id,
    roomId: row.room_id,
    instanceId: row.instance_id,
    message: {
      id: row.message_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      text: row.body,
      sentAtMs: row.sent_at_ms,
    },
    reportedAtMs: row.reported_at_ms,
    status: row.status,
    action: row.action,
  });
}

export function createReport(db: D1Database, input: ReportSubmission) {
  const now = Date.now();
  const id = crypto.randomUUID();
  return submitRoomReport(reportSubmissionStore(db), input, now, id);
}

function reportSubmissionStore(db: D1Database): ReportSubmissionStore {
  return {
    async insert(input, id, now, window) {
      const result = await db
        .prepare(`
    INSERT OR IGNORE INTO reports
      (id, room_id, instance_id, message_id, sender_id, sender_name, body, sent_at_ms,
       reporter_hash, reported_at_ms, expires_at_ms)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM reports WHERE instance_id = ? AND reporter_hash = ? AND reported_at_ms > ?
    )
  `)
        .bind(
          id,
          input.roomId,
          input.instanceId,
          input.message.id,
          input.message.senderId,
          input.message.senderName,
          input.message.text,
          input.message.sentAtMs,
          input.reporterHash,
          now,
          window.expiresAtMs,
          input.instanceId,
          input.reporterHash,
          window.precedingReportAfter,
        )
        .run();
      return result.meta.changes > 0;
    },
    async hasDuplicate(input, now) {
      const duplicate = await db
        .prepare(
          "SELECT id FROM reports WHERE instance_id = ? AND message_id = ? AND reporter_hash = ? AND expires_at_ms > ?",
        )
        .bind(input.instanceId, input.message.id, input.reporterHash, now)
        .first();
      return Boolean(duplicate);
    },
  };
}

export async function getReport(db: D1Database, id: string): Promise<ModerationReport | null> {
  const row = await db
    .prepare("SELECT * FROM reports WHERE id = ? AND expires_at_ms > ?")
    .bind(id, Date.now())
    .first<ReportRow>();
  return row === null ? null : toReport(row);
}

export function reportListStore(db: D1Database): ReportListStore<ReportRow> {
  return {
    async readPage(after, take) {
      const rows = await db
        .prepare(`SELECT * FROM reports WHERE expires_at_ms > ?
    AND (? IS NULL OR reported_at_ms < ? OR (reported_at_ms = ? AND id < ?))
    ORDER BY reported_at_ms DESC, id DESC LIMIT ${take}`)
        .bind(
          Date.now(),
          after?.time ?? null,
          after?.time ?? null,
          after?.time ?? null,
          after?.id ?? null,
        )
        .all<ReportRow>();
      return rows.results;
    },
    toReport,
    position: (row) => ({ time: row.reported_at_ms, id: row.id }),
  };
}

export async function resolveReport(
  db: D1Database,
  id: string,
  action: ModerationReport["action"],
): Promise<ModerationReport | null> {
  await db
    .prepare(
      "UPDATE reports SET status = 'resolved', action = ? WHERE id = ? AND status = 'open' AND expires_at_ms > ?",
    )
    .bind(action, id, Date.now())
    .run();
  return getReport(db, id);
}

export async function deleteExpiredReports(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare("DELETE FROM reports WHERE expires_at_ms <= ?").bind(now).run();
}
