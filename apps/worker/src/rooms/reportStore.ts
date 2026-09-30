import {
  moderationReportSchema,
  type ChatMessage,
  type ModerationReport,
} from "@tetraboard/protocol";

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

const retentionMs = 7 * 24 * 60 * 60 * 1000;

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

export async function createReport(
  db: D1Database,
  input: {
    roomId: string;
    instanceId: string;
    message: ChatMessage;
    reporterHash: string;
  },
): Promise<{ status: "created"; id: string } | { status: "duplicate" | "rate_limited" }> {
  const now = Date.now();
  const id = crypto.randomUUID();
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
      now + retentionMs,
      input.instanceId,
      input.reporterHash,
      now - 3_000,
    )
    .run();
  if (result.meta.changes > 0) return { status: "created", id };
  const duplicate = await db
    .prepare(
      "SELECT id FROM reports WHERE instance_id = ? AND message_id = ? AND reporter_hash = ? AND expires_at_ms > ?",
    )
    .bind(input.instanceId, input.message.id, input.reporterHash, now)
    .first();
  return { status: duplicate ? "duplicate" : "rate_limited" };
}

export async function getReport(db: D1Database, id: string): Promise<ModerationReport | null> {
  const row = await db
    .prepare("SELECT * FROM reports WHERE id = ? AND expires_at_ms > ?")
    .bind(id, Date.now())
    .first<ReportRow>();
  return row === null ? null : toReport(row);
}

export async function listReports(
  db: D1Database,
  cursor: string | undefined,
): Promise<{ reports: ModerationReport[]; nextCursor: string | null }> {
  const parts = cursor?.split(":");
  if (
    parts !== undefined &&
    (parts.length !== 2 ||
      !/^\d{1,16}$/.test(parts[0]) ||
      !Number.isSafeInteger(Number(parts[0])) ||
      !/^[0-9a-f-]{36}$/.test(parts[1]))
  )
    throw new Error("Invalid cursor");
  const position = parts === undefined ? null : { time: Number(parts[0]), id: parts[1] };
  const rows = await db
    .prepare(`SELECT * FROM reports WHERE expires_at_ms > ?
    AND (? IS NULL OR reported_at_ms < ? OR (reported_at_ms = ? AND id < ?))
    ORDER BY reported_at_ms DESC, id DESC LIMIT 21`)
    .bind(
      Date.now(),
      position?.time ?? null,
      position?.time ?? null,
      position?.time ?? null,
      position?.id ?? null,
    )
    .all<ReportRow>();
  const page = rows.results.slice(0, 20).map(toReport);
  const last = rows.results[19];
  return {
    reports: page,
    nextCursor:
      rows.results.length > 20 && last !== undefined ? `${last.reported_at_ms}:${last.id}` : null,
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
