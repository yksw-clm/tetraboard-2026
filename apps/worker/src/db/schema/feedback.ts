import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id"),
    submissionId: text("submission_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    author: text("author").notNull(),
    reporterHash: text("reporter_hash").notNull(),
    internal: integer("internal").notNull(),
    kind: text("kind").notNull(),
    game: text("game").notNull(),
    body: text("body").notNull(),
    expectation: text("expectation").notNull(),
    steps: text("steps").notNull(),
    technical: text("technical"),
    receivedAtMs: integer("received_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    firstReviewedAtMs: integer("first_reviewed_at_ms"),
    status: text("status")
      .notNull()
      .default(sql`'new'`),
    priority: text("priority")
      .notNull()
      .default(sql`'normal'`),
    topicId: text("topic_id").references(() => feedbackTopics.id),
    note: text("note")
      .notNull()
      .default(sql`''`),
    issueUrl: text("issue_url")
      .notNull()
      .default(sql`''`),
    version: integer("version")
      .notNull()
      .default(sql`1`),
    attachmentKey: text("attachment_key"),
    ready: integer("ready")
      .notNull()
      .default(sql`0`),
    deleted: integer("deleted")
      .notNull()
      .default(sql`0`),
    accountId: text("account_id"),
    rating: integer("rating"),
    opponent: text("opponent"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    unique("feedback_submission_id_unique").on(t.submissionId),
    index("feedback_newest").on(t.ready, t.deleted, sql`${t.receivedAtMs} desc`, sql`${t.id} desc`),
    index("feedback_expiry").on(t.expiresAtMs),
    index("feedback_account").on(t.accountId),
    check("feedback_check_1", sql`rating BETWEEN 1 AND 5`),
    check("feedback_check_2", sql`opponent IN ('cpu', 'human')`),
  ],
);

export const feedbackHistory = sqliteTable(
  "feedback_history",
  {
    id: text("id"),
    feedbackId: text("feedback_id")
      .notNull()
      .references(() => feedback.id, { onDelete: "cascade" }),
    adminId: text("admin_id").notNull(),
    adminName: text("admin_name").notNull(),
    atMs: integer("at_ms").notNull(),
    changes: text("changes").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("feedback_history_record").on(t.feedbackId, t.atMs),
  ],
);

export const feedbackLimits = sqliteTable(
  "feedback_limits",
  {
    key: text("key").notNull(),
    windowMs: integer("window_ms").notNull(),
    count: integer("count").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.windowMs] }),
    index("feedback_limits_expiry").on(t.expiresAtMs),
  ],
);

export const feedbackTopics = sqliteTable(
  "feedback_topics",
  {
    id: text("id"),
    name: text("name").notNull(),
    version: integer("version")
      .notNull()
      .default(sql`1`),
  },
  (t) => [primaryKey({ columns: [t.id] }), unique("feedback_topics_name_unique").on(t.name)],
);

export const feedbackUploads = sqliteTable(
  "feedback_uploads",
  {
    key: text("key"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.key] })],
);
