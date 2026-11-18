import type { FeedbackPatch, FeedbackQuery } from "@tetraboard/protocol";
import {
  feedbackChanges,
  feedbackPage,
  feedbackPageSize,
  type FeedbackCursor,
  type FeedbackEditStore,
} from "@tetraboard/context-community";
import { feedbackRow, toFeedback, type FeedbackRow } from "./feedbackRecord";

export async function listFeedback(db: D1Database, query: FeedbackQuery) {
  const where = ["ready = 1", "deleted = 0", "expires_at_ms > ?"];
  const values: (string | number)[] = [Date.now()];
  for (const [field, column] of [
    ["kind", "kind"],
    ["game", "game"],
    ["status", "status"],
    ["priority", "priority"],
    ["author", "author"],
    ["opponent", "opponent"],
    ["rating", "rating"],
  ] as const) {
    if (query[field]) {
      where.push(`${column} = ?`);
      values.push(query[field]!);
    }
  }
  if (query.topicId === "none") where.push("topic_id IS NULL");
  else if (query.topicId) {
    where.push("topic_id = ?");
    values.push(query.topicId);
  }
  if (query.cursor) {
    const cursor = decodeFeedbackCursor(query.cursor);
    where.push("(received_at_ms < ? OR (received_at_ms = ? AND id < ?))");
    values.push(cursor.at, cursor.at, cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT * FROM feedback WHERE ${where.join(" AND ")} ORDER BY received_at_ms DESC, id DESC LIMIT ${feedbackPageSize + 1}`,
    )
    .bind(...values)
    .all<FeedbackRow>();
  const page = feedbackPage(rows.results, toFeedback, (row) => ({
    at: row.received_at_ms,
    id: row.id,
  }));
  return {
    ...page,
    nextCursor: page.nextCursor ? btoa(JSON.stringify(page.nextCursor)) : null,
  };
}
export function feedbackEditStore(db: D1Database): FeedbackEditStore<FeedbackRow> {
  return {
    read: (id) => feedbackRow(db, id),
    topicExists: (id) => feedbackTopicExists(db, id),
    update: (row, input, editor) => patchFeedback(db, row, input, editor),
    record: toFeedback,
  };
}

async function patchFeedback(
  db: D1Database,
  row: FeedbackRow,
  input: FeedbackPatch,
  admin: { id: string; name: string },
) {
  const now = Date.now();
  const changes = feedbackChanges(toFeedback(row), input);
  const result = await db.batch([
    db
      .prepare(`UPDATE feedback SET status = ?, priority = ?, topic_id = ?, note = ?, issue_url = ?,
      first_reviewed_at_ms = CASE WHEN first_reviewed_at_ms IS NULL AND status = 'new' AND ? != 'new' THEN ? ELSE first_reviewed_at_ms END,
      version = version + 1 WHERE id = ? AND version = ? AND ready = 1 AND deleted = 0 AND expires_at_ms > ?`)
      .bind(
        input.status,
        input.priority,
        input.topicId,
        input.note,
        input.issueUrl,
        input.status,
        now,
        row.id,
        input.version,
        now,
      ),
    db
      .prepare(`INSERT INTO feedback_history (id, feedback_id, admin_id, admin_name, at_ms, changes)
      SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
      .bind(crypto.randomUUID(), row.id, admin.id, admin.name, now, JSON.stringify(changes)),
  ]);
  return result[0].meta.changes > 0;
}
export async function feedbackSummary(db: D1Database, includeInternal: boolean) {
  const now = Date.now();
  const where = `ready = 1 AND deleted = 0 AND expires_at_ms > ? AND status != 'spam' ${includeInternal ? "" : "AND internal = 0"}`;
  const counts = await db
    .prepare(
      `SELECT COUNT(*) AS count, MIN(received_at_ms) AS oldest FROM feedback WHERE ${where} AND status = 'new'`,
    )
    .bind(now)
    .first<{ count: number; oldest: number | null }>();
  const median = await db
    .prepare(`WITH times AS (SELECT first_reviewed_at_ms - received_at_ms AS delay FROM feedback WHERE ${where} AND first_reviewed_at_ms IS NOT NULL),
    ordered AS (SELECT delay, ROW_NUMBER() OVER (ORDER BY delay) AS position, COUNT(*) OVER () AS total FROM times)
    SELECT AVG(delay) AS median FROM ordered WHERE position IN ((total + 1) / 2, (total + 2) / 2)`)
    .bind(now)
    .first<{ median: number | null }>();
  const rows = await db
    .prepare(`SELECT topic_id AS id, COALESCE(t.name, '未分類') AS name, COUNT(*) AS posts, COUNT(DISTINCT reporter_hash) AS reporters
    FROM feedback LEFT JOIN feedback_topics t ON t.id = feedback.topic_id WHERE ${where} GROUP BY topic_id ORDER BY posts DESC, name`)
    .bind(now)
    .all<{ id: string | null; name: string; posts: number; reporters: number }>();
  return {
    asOfMs: now,
    unreviewed: counts?.count ?? 0,
    oldestUnreviewedMs:
      counts?.oldest === null || counts?.oldest === undefined ? null : now - counts.oldest,
    medianReviewMs: median?.median ?? null,
    topics: rows.results,
  };
}

function decodeFeedbackCursor(encoded: string) {
  const cursor = JSON.parse(atob(encoded));
  if (
    !Number.isSafeInteger(cursor.at) ||
    cursor.at < 0 ||
    typeof cursor.id !== "string" ||
    !/^[\da-f-]{36}$/.test(cursor.id)
  )
    throw new Error("cursor");
  return cursor as FeedbackCursor;
}

export async function feedbackTopics(db: D1Database) {
  const rows = await db
    .prepare("SELECT id, name, version FROM feedback_topics ORDER BY name, id")
    .all();
  return rows.results;
}

export async function createFeedbackTopic(db: D1Database, name: string) {
  const id = crypto.randomUUID();
  const result = await db
    .prepare("INSERT OR IGNORE INTO feedback_topics (id, name) VALUES (?, ?)")
    .bind(id, name)
    .run();
  return result.meta.changes ? id : null;
}

export async function updateFeedbackTopic(
  db: D1Database,
  id: string,
  name: string,
  version: number,
) {
  const result = await db
    .prepare(
      "UPDATE OR IGNORE feedback_topics SET name = ?, version = version + 1 WHERE id = ? AND version = ?",
    )
    .bind(name, id, version)
    .run();
  return Boolean(result.meta.changes);
}

export async function feedbackHistory(db: D1Database, id: string) {
  const history = await db
    .prepare(
      "SELECT at_ms, admin_name, changes FROM feedback_history WHERE feedback_id = ? ORDER BY at_ms, id",
    )
    .bind(id)
    .all<{ at_ms: number; admin_name: string; changes: string }>();
  return history.results.map((v) => ({
    atMs: v.at_ms,
    admin: v.admin_name,
    changes: JSON.parse(v.changes),
  }));
}

async function feedbackTopicExists(db: D1Database, id: string) {
  return Boolean(await db.prepare("SELECT id FROM feedback_topics WHERE id = ?").bind(id).first());
}

export async function hideFeedback(db: D1Database, id: string, version: number) {
  const result = await db
    .prepare(
      "UPDATE feedback SET deleted = 1, version = version + 1 WHERE id = ? AND version = ? AND deleted = 0",
    )
    .bind(id, version)
    .run();
  return Boolean(result.meta.changes);
}
