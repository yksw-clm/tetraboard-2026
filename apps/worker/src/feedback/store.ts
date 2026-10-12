import {
  feedbackRecordSchema,
  type FeedbackInput,
  type FeedbackQuery,
  type FeedbackRecord,
  type FeedbackPatch,
} from "@tetraboard/protocol";

export const feedbackRetentionMs = 180 * 86400000;
export type FeedbackRow = {
  id: string;
  submission_id: string;
  payload_hash: string;
  author: "account" | "guest";
  reporter_hash: string;
  internal: number;
  kind: FeedbackRecord["kind"];
  game: FeedbackRecord["game"];
  body: string;
  expectation: string;
  steps: string;
  technical: string | null;
  received_at_ms: number;
  expires_at_ms: number;
  first_reviewed_at_ms: number | null;
  status: FeedbackRecord["status"];
  priority: FeedbackRecord["priority"];
  topic_id: string | null;
  note: string;
  issue_url: string;
  version: number;
  attachment_key: string | null;
  ready: number;
  deleted: number;
};
export function toFeedback(row: FeedbackRow): FeedbackRecord {
  return feedbackRecordSchema.parse({
    id: row.id,
    kind: row.kind,
    game: row.game,
    body: row.body,
    expectation: row.expectation,
    steps: row.steps,
    technical: row.technical ? JSON.parse(row.technical) : null,
    author: row.author,
    internal: Boolean(row.internal),
    receivedAtMs: row.received_at_ms,
    expiresAtMs: row.expires_at_ms,
    firstReviewedAtMs: row.first_reviewed_at_ms,
    status: row.status,
    priority: row.priority,
    topicId: row.topic_id,
    note: row.note,
    issueUrl: row.issue_url,
    hasAttachment: row.attachment_key !== null,
    version: row.version,
  });
}
export async function feedbackRow(db: D1Database, id: string) {
  return db
    .prepare(
      "SELECT * FROM feedback WHERE id = ? AND ready = 1 AND deleted = 0 AND expires_at_ms > ?",
    )
    .bind(id, Date.now())
    .first<FeedbackRow>();
}
export async function submissionRow(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM feedback WHERE submission_id = ?").bind(id).first<FeedbackRow>();
}
export async function reserveFeedback(
  db: D1Database,
  input: FeedbackInput,
  identity: {
    reporterHash: string;
    browserHash: string;
    ipHash: string;
    author: "account" | "guest";
    accountId?: string | null;
    internal: boolean;
  },
  payloadHash: string,
  attachment: boolean,
): Promise<FeedbackRow | null> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const key = attachment ? `feedback/${id}.webp` : null;
  const limits = [
    [identity.reporterHash, 600000, 5],
    [identity.reporterHash, 86400000, 20],
    [identity.browserHash, 600000, 5],
    [identity.browserHash, 86400000, 20],
    [identity.ipHash, 600000, 30],
  ]
    .filter(
      ([hash, span], index, all) => all.findIndex(([h, s]) => h === hash && s === span) === index,
    )
    .map(([hash, span, max]) => ({
      key: `${hash}:${span}`,
      span: Number(span),
      max: Number(max),
      start: Math.floor(now / Number(span)) * Number(span),
    }));
  const checks = limits
    .map(
      () =>
        "NOT EXISTS (SELECT 1 FROM feedback_limits WHERE key = ? AND window_ms = ? AND count >= ?)",
    )
    .join(" AND ");
  const insert = db
    .prepare(`INSERT OR IGNORE INTO feedback
    (id, submission_id, payload_hash, author, reporter_hash, internal, kind, game, body, expectation, steps, technical, received_at_ms, expires_at_ms, attachment_key,account_id)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,? WHERE ${checks}`)
    .bind(
      id,
      input.submissionId,
      payloadHash,
      identity.author,
      identity.reporterHash,
      Number(identity.internal),
      input.kind,
      input.game,
      input.body,
      input.expectation,
      input.steps,
      input.technical ? JSON.stringify(input.technical) : null,
      now,
      now + feedbackRetentionMs,
      key,
      identity.accountId ?? null,
      ...limits.flatMap((v) => [v.key, v.start, v.max]),
    );
  const statements = [
    insert,
    ...limits.map((v) =>
      db
        .prepare(`INSERT INTO feedback_limits (key, window_ms, count, expires_at_ms)
    SELECT ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM feedback WHERE id = ?)
    ON CONFLICT(key, window_ms) DO UPDATE SET count = count + 1`)
        .bind(v.key, v.start, v.start + v.span, id),
    ),
  ];
  if (key)
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO feedback_uploads (key, created_at_ms) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM feedback WHERE id = ?)",
        )
        .bind(key, now, id),
    );
  await db.batch(statements);
  return submissionRow(db, input.submissionId);
}
export async function listFeedback(db: D1Database, query: FeedbackQuery) {
  const where = ["ready = 1", "deleted = 0", "expires_at_ms > ?"];
  const values: (string | number)[] = [Date.now()];
  for (const [field, column] of [
    ["kind", "kind"],
    ["game", "game"],
    ["status", "status"],
    ["priority", "priority"],
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
    const cursor = JSON.parse(atob(query.cursor));
    if (
      !Number.isSafeInteger(cursor.at) ||
      cursor.at < 0 ||
      typeof cursor.id !== "string" ||
      !/^[\da-f-]{36}$/.test(cursor.id)
    )
      throw new Error("cursor");
    where.push("(received_at_ms < ? OR (received_at_ms = ? AND id < ?))");
    values.push(cursor.at, cursor.at, cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT * FROM feedback WHERE ${where.join(" AND ")} ORDER BY received_at_ms DESC, id DESC LIMIT 51`,
    )
    .bind(...values)
    .all<FeedbackRow>();
  const page = rows.results.slice(0, 50);
  const last = page.at(-1);
  return {
    feedback: page.map(toFeedback),
    nextCursor:
      rows.results.length > 50 && last
        ? btoa(JSON.stringify({ at: last.received_at_ms, id: last.id }))
        : null,
  };
}
export async function patchFeedback(
  db: D1Database,
  row: FeedbackRow,
  input: FeedbackPatch,
  admin: { id: string; name: string },
) {
  const now = Date.now();
  const next = {
    status: input.status,
    priority: input.priority,
    topicId: input.topicId,
    note: input.note,
    issueUrl: input.issueUrl,
  };
  const old = toFeedback(row);
  const changes = Object.fromEntries(
    Object.entries(next)
      .filter(([key, value]) => old[key as keyof FeedbackRecord] !== value)
      .map(([key, value]) => [key, { before: old[key as keyof FeedbackRecord], after: value }]),
  );
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
export async function cleanupFeedback(
  env: { APP_DB: D1Database; OBJECT_STORAGE: R2Bucket },
  now = Date.now(),
) {
  // 閲覧対象から先に外し、R2削除が完了するまでD1を残して次回も再試行できます。
  const rows = await env.APP_DB.prepare(
    "SELECT id, attachment_key FROM feedback WHERE deleted = 1 OR expires_at_ms <= ? OR (ready = 0 AND received_at_ms <= ?) LIMIT 100",
  )
    .bind(now, now - 86400000)
    .all<{ id: string; attachment_key: string | null }>();
  for (const row of rows.results) {
    await env.APP_DB.prepare("UPDATE feedback SET deleted = 1 WHERE id = ?").bind(row.id).run();
    try {
      if (row.attachment_key) await env.OBJECT_STORAGE.delete(row.attachment_key);
      await env.APP_DB.batch([
        env.APP_DB.prepare("DELETE FROM feedback_history WHERE feedback_id = ?").bind(row.id),
        env.APP_DB.prepare("DELETE FROM feedback WHERE id = ? AND deleted = 1").bind(row.id),
        env.APP_DB.prepare("DELETE FROM feedback_uploads WHERE key = ?").bind(
          row.attachment_key ?? "",
        ),
      ]);
    } catch {
      /* 次の毎時処理で再試行します。投稿内容をログに記録しません。 */
    }
  }
  const orphans = await env.APP_DB.prepare(
    "SELECT key FROM feedback_uploads WHERE created_at_ms <= ? AND NOT EXISTS (SELECT 1 FROM feedback WHERE attachment_key = feedback_uploads.key) LIMIT 100",
  )
    .bind(now - 86400000)
    .all<{ key: string }>();
  for (const row of orphans.results) {
    try {
      await env.OBJECT_STORAGE.delete(row.key);
      await env.APP_DB.prepare("DELETE FROM feedback_uploads WHERE key = ?").bind(row.key).run();
    } catch {
      /* 再試行 */
    }
  }
  await env.APP_DB.prepare("DELETE FROM feedback_limits WHERE expires_at_ms <= ?").bind(now).run();
}
