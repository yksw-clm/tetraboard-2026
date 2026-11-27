import {
  notificationPageSize,
  type NotificationQuery,
  type NotificationStore,
} from "@tetraboard/context-community";
import { notificationSchema, type Notification } from "@tetraboard/protocol";
import { accountNotDeletedSql } from "../../db/deletionGuard";
import { boardPublishedSql } from "./boardRows";

export function notificationRecipientAllowedSql(accountId: string) {
  return `(${accountId}='' OR ${accountNotDeletedSql(accountId)})`;
}

const notificationFromSql = `FROM notification_events e
  LEFT JOIN board_posts reply ON e.kind='reply' AND reply.id=e.source_id
  LEFT JOIN board_posts parent ON parent.id=reply.parent_id
  LEFT JOIN user author ON author.id=reply.account_id`;
const visibleNotificationSql = (includeReplies: boolean) =>
  `((e.account_id=? AND ${accountNotDeletedSql("e.account_id")}) OR (e.account_id='' AND EXISTS(
    SELECT 1 FROM announcements a WHERE a.id=e.source_id AND a.published=1)))
  AND (e.kind<>'reply'${
    includeReplies
      ? ` OR (e.account_id<>'' AND parent.id IS NOT NULL AND author.id IS NOT NULL
        AND ${boardPublishedSql("reply")} AND ${boardPublishedSql("parent")})`
      : ""
  })`;
const readSql = `(e.legacy=1 OR e.seq<=COALESCE(s.read_all_seq,0)
  OR (e.account_id='' AND e.seq<=COALESCE(s.baseline_seq,0))
  OR EXISTS(SELECT 1 FROM account_notification_reads r WHERE r.account_id=? AND r.notification_seq=e.seq))`;
export async function initializeNotifications(db: D1Database, accountId: string) {
  await db
    .prepare(`INSERT OR IGNORE INTO account_notification_state(account_id,baseline_seq)
    SELECT ?1,COALESCE((SELECT MAX(seq) FROM notification_events WHERE account_id=''),0)
    WHERE ${accountNotDeletedSql("?1")}`)
    .bind(accountId)
    .run();
}
export async function notificationUpperBound(
  db: D1Database,
  accountId: string,
  includeReplies = false,
) {
  const row = await db
    .prepare(`SELECT COALESCE(MAX(e.seq),0) AS upperBound ${notificationFromSql}
    WHERE ${visibleNotificationSql(includeReplies)}`)
    .bind(accountId || null)
    .first<{ upperBound: number }>();
  return row!.upperBound;
}
export async function hasUnreadNotifications(
  db: D1Database,
  accountId: string,
  includeReplies = false,
) {
  return Boolean(
    await db
      .prepare(`SELECT 1 ${notificationFromSql}
    LEFT JOIN account_notification_state s ON s.account_id=?
    WHERE ${visibleNotificationSql(includeReplies)} AND NOT ${readSql} LIMIT 1`)
      .bind(accountId, accountId, accountId)
      .first(),
  );
}

type NotificationRow = {
  seq: number;
  kind: string;
  created_at_ms: number;
  legacy: number;
  is_read: number;
  source_id: string;
  payload_json: string;
  title: string | null;
  body: string | null;
  date: string | null;
  postId: string | null;
  gameId: string | null;
  authorName: string | null;
  replyText: string | null;
};

function notificationFromRow(row: NotificationRow): Notification {
  const common = {
    id: row.seq,
    kind: row.kind,
    createdAtMs: row.created_at_ms,
    legacy: Boolean(row.legacy),
    read: Boolean(row.is_read),
  };
  switch (row.kind) {
    case "announcement":
      return notificationSchema.parse({
        ...common,
        announcement: { id: row.source_id, title: row.title, body: row.body, date: row.date },
      });
    case "reply":
      return notificationSchema.parse({
        ...common,
        reply: {
          postId: row.postId,
          replyId: row.source_id,
          gameId: row.gameId,
          authorName: row.authorName,
          text: row.replyText,
        },
      });
    case "badge":
      return notificationSchema.parse({ ...common, badge: JSON.parse(row.payload_json) });
    default:
      return notificationSchema.parse({ ...common, tournament: JSON.parse(row.payload_json) });
  }
}

export async function readNotifications(
  db: D1Database,
  accountId: string,
  options: NotificationQuery = {},
): Promise<Notification[]> {
  const { before, after, id, announcementId, includeReplies = false } = options;
  const conditions = [visibleNotificationSql(includeReplies)];
  const values: (string | number | null)[] = [accountId || null];
  if (before !== undefined) {
    conditions.push("e.seq<?");
    values.push(before);
  }
  if (after !== undefined) {
    conditions.push("e.seq>?");
    values.push(after);
  }
  if (id !== undefined) {
    conditions.push("e.seq=?");
    values.push(id);
  }
  if (announcementId !== undefined) {
    conditions.push("e.kind='announcement' AND e.source_id=?");
    values.push(announcementId);
  }
  const rows = await db
    .prepare(`SELECT e.*,${readSql} AS is_read,a.title,a.body,a.published_on AS date,
      reply.parent_id AS postId,reply.game_id AS gameId,author.name AS authorName,reply.body AS replyText
    ${notificationFromSql} LEFT JOIN account_notification_state s ON s.account_id=?
    LEFT JOIN announcements a ON e.kind='announcement' AND a.id=e.source_id
    WHERE ${conditions.join(" AND ")} ORDER BY e.seq DESC LIMIT ${notificationPageSize + 1}`)
    .bind(accountId, accountId, ...values)
    .all<NotificationRow>();
  return rows.results.map(notificationFromRow);
}

export function notificationRequestStore(db: D1Database): NotificationStore {
  let initializedAccountId: string | undefined;
  return {
    async initializeReadState(accountId) {
      // 同じリクエストで既読操作に進む場合は、ミドルウェアで作った基準を使います。
      if (initializedAccountId === accountId) return;
      await initializeNotifications(db, accountId);
      initializedAccountId = accountId;
    },
    list: (accountId, query) => readNotifications(db, accountId, query),
    upperBound: (accountId, includeReplies) =>
      notificationUpperBound(db, accountId, includeReplies),
    hasUnread: (accountId, includeReplies) => hasUnreadNotifications(db, accountId, includeReplies),
    async insertRead(accountId, id) {
      const result = await db
        .prepare(`INSERT OR IGNORE INTO account_notification_reads(account_id,notification_seq)
    SELECT ?1,e.seq ${notificationFromSql}
    WHERE e.seq=? AND ${visibleNotificationSql(true)} AND ${accountNotDeletedSql("?1")}
    RETURNING notification_seq`)
        .bind(accountId, id, accountId)
        .first();
      return Boolean(result);
    },
    async issuedThrough() {
      const frontier = await db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name='notification_events'")
        .first<{ seq: number }>();
      return frontier?.seq ?? 0;
    },
    async advanceReadAll(accountId, through) {
      await db
        .prepare(
          "UPDATE account_notification_state SET read_all_seq=MAX(read_all_seq,?) WHERE account_id=?",
        )
        .bind(through, accountId)
        .run();
    },
  };
}

/** 統合前の既読を実体化してから宛先を移し、双方の未読を勝手に消しません。 */
export function mergeNotificationStatements(db: D1Database, guest: string, target: string) {
  return [
    db
      .prepare(`INSERT OR IGNORE INTO account_notification_reads(account_id,notification_seq)
      SELECT ?1,e.seq FROM notification_events e JOIN account_notification_state s ON s.account_id=?1
      WHERE (e.account_id=?1 OR e.account_id='') AND (e.seq<=s.read_all_seq OR (e.account_id='' AND e.seq<=s.baseline_seq))
        AND ${accountNotDeletedSql("?1")}`)
      .bind(target),
    db
      .prepare(`INSERT OR IGNORE INTO account_notification_reads(account_id,notification_seq)
      SELECT ?1,COALESCE(t.seq,e.seq) FROM notification_events e
      LEFT JOIN notification_events t ON t.account_id=?1 AND t.kind=e.kind AND t.source_id=e.source_id
      LEFT JOIN account_notification_state s ON s.account_id=?
      WHERE (e.account_id=? OR e.account_id='') AND (e.seq<=COALESCE(s.read_all_seq,0)
        OR (e.account_id='' AND e.seq<=COALESCE(s.baseline_seq,0))
        OR EXISTS(SELECT 1 FROM account_notification_reads r WHERE r.account_id=? AND r.notification_seq=e.seq))
        AND ${accountNotDeletedSql("?1")}`)
      .bind(target, guest, guest, guest),
    db
      .prepare(`DELETE FROM notification_events WHERE account_id=? AND EXISTS(
      SELECT 1 FROM notification_events t WHERE t.account_id=? AND t.kind=notification_events.kind AND t.source_id=notification_events.source_id)`)
      .bind(guest, target),
    db
      .prepare(
        `UPDATE notification_events SET account_id=?1 WHERE account_id=? AND ${notificationRecipientAllowedSql("?1")}`,
      )
      .bind(target, guest),
    db
      .prepare(`INSERT INTO account_notification_state(account_id,baseline_seq,read_all_seq)
      SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM account_notification_state WHERE account_id IN (?1,?))
        THEN 0 ELSE COALESCE((SELECT MAX(seq) FROM notification_events WHERE account_id=''),0) END,0
      WHERE ${accountNotDeletedSql("?1")}
      ON CONFLICT(account_id) DO UPDATE SET baseline_seq=0,read_all_seq=0`)
      .bind(target, guest),
    db.prepare("DELETE FROM account_notification_reads WHERE account_id=?").bind(guest),
    db.prepare("DELETE FROM account_notification_state WHERE account_id=?").bind(guest),
  ];
}
