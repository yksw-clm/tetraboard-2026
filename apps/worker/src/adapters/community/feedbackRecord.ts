import { feedbackRecordSchema, type FeedbackRecord } from "@tetraboard/protocol";

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
  rating: number | null;
  opponent: "cpu" | "human" | null;
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
    rating: row.rating,
    opponent: row.opponent,
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
