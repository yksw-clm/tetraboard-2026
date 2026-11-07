import { notificationSchema, type Notification } from "@tetraboard/protocol";

export const visibleNotificationSql = `((e.account_id=? AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=e.account_id)) OR (e.account_id='' AND EXISTS(
  SELECT 1 FROM announcements a WHERE a.id=e.source_id AND a.published=1)))`;
const readSql = `(e.legacy=1 OR e.seq<=COALESCE(s.read_all_seq,0)
  OR (e.account_id='' AND e.seq<=COALESCE(s.baseline_seq,0))
  OR EXISTS(SELECT 1 FROM account_notification_reads r WHERE r.account_id=? AND r.notification_seq=e.seq))`;
export async function initializeNotifications(db: D1Database, accountId: string) {
  await db
    .prepare(`INSERT OR IGNORE INTO account_notification_state(account_id,baseline_seq)
    SELECT ?,COALESCE(MAX(seq),0) FROM notification_events WHERE account_id=''`)
    .bind(accountId)
    .run();
}
export async function notificationUpperBound(db: D1Database, accountId: string) {
  const row = await db
    .prepare(`SELECT COALESCE(MAX(e.seq),0) AS upperBound FROM notification_events e
    WHERE ${visibleNotificationSql}`)
    .bind(accountId || null)
    .first<{ upperBound: number }>();
  return row!.upperBound;
}
export async function hasUnreadNotifications(db: D1Database, accountId: string) {
  return Boolean(
    await db
      .prepare(`SELECT 1 FROM notification_events e
    LEFT JOIN account_notification_state s ON s.account_id=?
    WHERE ${visibleNotificationSql} AND NOT ${readSql} LIMIT 1`)
      .bind(accountId, accountId, accountId)
      .first(),
  );
}
export async function readNotifications(
  db: D1Database,
  accountId: string,
  options: {
    before?: number;
    after?: number;
    id?: number;
    announcementId?: string;
  } = {},
): Promise<Notification[]> {
  const conditions = [visibleNotificationSql];
  const values: (string | number | null)[] = [accountId || null];
  if (options.before !== undefined) {
    conditions.push("e.seq<?");
    values.push(options.before);
  }
  if (options.after !== undefined) {
    conditions.push("e.seq>?");
    values.push(options.after);
  }
  if (options.id !== undefined) {
    conditions.push("e.seq=?");
    values.push(options.id);
  }
  if (options.announcementId !== undefined) {
    conditions.push("e.kind='announcement' AND e.source_id=?");
    values.push(options.announcementId);
  }
  const rows = await db
    .prepare(`SELECT e.*,${readSql} AS is_read,a.title,a.body,a.date
    FROM notification_events e LEFT JOIN account_notification_state s ON s.account_id=?
    LEFT JOIN announcements a ON e.kind='announcement' AND a.id=e.source_id
    WHERE ${conditions.join(" AND ")} ORDER BY e.seq DESC LIMIT 21`)
    .bind(accountId, accountId, ...values)
    .all<{
      seq: number;
      kind: string;
      created_at_ms: number;
      legacy: number;
      is_read: number;
      source_id: string;
      title: string;
      body: string;
      date: string;
      payload_json: string;
    }>();
  return rows.results.map((row) =>
    notificationSchema.parse({
      id: row.seq,
      kind: row.kind,
      createdAtMs: row.created_at_ms,
      legacy: Boolean(row.legacy),
      read: Boolean(row.is_read),
      ...(row.kind === "announcement"
        ? { announcement: { id: row.source_id, title: row.title, body: row.body, date: row.date } }
        : row.kind === "badge"
          ? { badge: JSON.parse(row.payload_json) }
          : { tournament: JSON.parse(row.payload_json) }),
    }),
  );
}

/** 統合前の既読を実体化してから宛先を移し、双方の未読を勝手に消しません。 */
export function mergeNotificationStatements(db: D1Database, guest: string, target: string) {
  return [
    db
      .prepare(`INSERT OR IGNORE INTO account_notification_reads(account_id,notification_seq)
      SELECT ?,e.seq FROM notification_events e JOIN account_notification_state s ON s.account_id=?
      WHERE (e.account_id=? OR e.account_id='') AND (e.seq<=s.read_all_seq OR (e.account_id='' AND e.seq<=s.baseline_seq))`)
      .bind(target, target, target),
    db
      .prepare(`INSERT OR IGNORE INTO account_notification_reads(account_id,notification_seq)
      SELECT ?,COALESCE(t.seq,e.seq) FROM notification_events e
      LEFT JOIN notification_events t ON t.account_id=? AND t.kind=e.kind AND t.source_id=e.source_id
      LEFT JOIN account_notification_state s ON s.account_id=?
      WHERE (e.account_id=? OR e.account_id='') AND (e.seq<=COALESCE(s.read_all_seq,0)
        OR (e.account_id='' AND e.seq<=COALESCE(s.baseline_seq,0))
        OR EXISTS(SELECT 1 FROM account_notification_reads r WHERE r.account_id=? AND r.notification_seq=e.seq))`)
      .bind(target, target, guest, guest, guest),
    db
      .prepare(`DELETE FROM notification_events WHERE account_id=? AND EXISTS(
      SELECT 1 FROM notification_events t WHERE t.account_id=? AND t.kind=notification_events.kind AND t.source_id=notification_events.source_id)`)
      .bind(guest, target),
    db
      .prepare("UPDATE notification_events SET account_id=? WHERE account_id=?")
      .bind(target, guest),
    db
      .prepare(`INSERT INTO account_notification_state(account_id,baseline_seq,read_all_seq)
      SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM account_notification_state WHERE account_id IN (?,?))
        THEN 0 ELSE COALESCE((SELECT MAX(seq) FROM notification_events WHERE account_id=''),0) END,0
      ON CONFLICT(account_id) DO UPDATE SET baseline_seq=0,read_all_seq=0`)
      .bind(target, guest, target),
    db.prepare("DELETE FROM account_notification_reads WHERE account_id=?").bind(guest),
    db.prepare("DELETE FROM account_notification_state WHERE account_id=?").bind(guest),
  ];
}
