import type { FeedbackInput } from "@tetraboard/protocol";
import {
  feedbackLimits,
  feedbackRetentionMs,
  type FeedbackIdentity,
  type FeedbackSubmission,
  type FeedbackSubmissionStore,
} from "@tetraboard/context-community";
import { feedbackRow, type FeedbackRow } from "./feedbackRecord";

async function submissionRow(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM feedback WHERE submission_id = ?").bind(id).first<FeedbackRow>();
}
async function reserveFeedback(
  db: D1Database,
  input: FeedbackInput,
  identity: FeedbackIdentity,
  payloadHash: string,
  attachment: boolean,
): Promise<FeedbackRow | null> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const key = attachment ? `feedback/${id}.webp` : null;
  const limits = feedbackLimits(identity, now);
  const checks = limits
    .map(
      () =>
        "NOT EXISTS (SELECT 1 FROM feedback_limits WHERE key = ? AND window_ms = ? AND count >= ?)",
    )
    .join(" AND ");
  const insert = db
    .prepare(`INSERT OR IGNORE INTO feedback
    (id, submission_id, payload_hash, author, reporter_hash, internal, kind, game, body, expectation, steps, technical, received_at_ms, expires_at_ms, attachment_key,account_id,rating,opponent)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${checks}`)
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
      input.rating ?? null,
      input.opponent ?? null,
      ...limits.flatMap((v) => [v.key, v.start, v.max]),
    );
  await db.batch(reservationStatements(db, insert, limits, id, key, now));
  return submissionRow(db, input.submissionId);
}

function reservationStatements(
  db: D1Database,
  insert: D1PreparedStatement,
  limits: ReturnType<typeof feedbackLimits>,
  id: string,
  key: string | null,
  now: number,
) {
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
  return statements;
}

function toSubmission(row: FeedbackRow | null): FeedbackSubmission | null {
  if (!row) return null;
  return {
    id: row.id,
    deleted: Boolean(row.deleted),
    expiresAtMs: row.expires_at_ms,
    payloadHash: row.payload_hash,
    ready: Boolean(row.ready),
    attachmentKey: row.attachment_key,
  };
}

export function feedbackSubmissionStore(
  db: D1Database,
  bucket: R2Bucket,
): Omit<FeedbackSubmissionStore, "authorWasDeleted"> {
  return {
    findSubmission: async (id) => toSubmission(await submissionRow(db, id)),
    reserve: async (input, identity, payloadHash, attachment) =>
      toSubmission(await reserveFeedback(db, input, identity, payloadHash, attachment)),
    async saveAttachment(key, image) {
      await bucket.put(key, image, { httpMetadata: { contentType: "image/webp" } });
    },
    async markReady(id, now) {
      await db
        .prepare("UPDATE feedback SET ready = 1 WHERE id = ? AND deleted = 0 AND expires_at_ms > ?")
        .bind(id, now)
        .run();
    },
    isReady: async (id) => Boolean(await feedbackRow(db, id)),
  };
}

export async function deleteFeedbackUpload(db: D1Database, key: string) {
  await db.prepare("DELETE FROM feedback_uploads WHERE key=?").bind(key).run();
}
