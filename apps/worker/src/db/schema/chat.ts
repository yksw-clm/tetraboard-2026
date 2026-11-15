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
import { tournaments } from "./tournaments";

export const lobbyChatMessages = sqliteTable(
  "lobby_chat_messages",
  {
    id: text("id"),
    accountId: text("account_id").notNull(),
    body: text("body").notNull(),
    sentAtMs: integer("sent_at_ms").notNull(),
    requestId: text("request_id").notNull(),
    bodyHash: text("body_hash").notNull(),
    senderPublicId: text("sender_public_id"),
    tournamentId: integer("tournament_id").references(() => tournaments.publicId),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    unique("lobby_chat_messages_account_id_request_id_unique").on(t.accountId, t.requestId),
    index("lobby_chat_messages_time").on(sql`${t.sentAtMs} desc`, sql`${t.id} desc`),
    index("lobby_chat_messages_account").on(t.accountId),
    index("lobby_chat_messages_scope_time").on(
      t.tournamentId,
      sql`${t.sentAtMs} desc`,
      sql`${t.id} desc`,
    ),
  ],
);

export const lobbyChatReports = sqliteTable(
  "lobby_chat_reports",
  {
    id: text("id"),
    messageId: text("message_id").notNull(),
    senderAccountId: text("sender_account_id"),
    senderPublicId: text("sender_public_id"),
    senderName: text("sender_name").notNull(),
    body: text("body").notNull(),
    sentAtMs: integer("sent_at_ms").notNull(),
    reporterAccountId: text("reporter_account_id"),
    reportedAtMs: integer("reported_at_ms").notNull(),
    status: text("status")
      .notNull()
      .default(sql`'pending'`),
    tournamentId: integer("tournament_id"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    unique("lobby_chat_reports_message_id_reporter_account_id_unique").on(
      t.messageId,
      t.reporterAccountId,
    ),
  ],
);

export const lobbyChatRequests = sqliteTable(
  "lobby_chat_requests",
  {
    accountId: text("account_id").notNull(),
    requestId: text("request_id").notNull(),
    messageId: text("message_id").notNull(),
    bodyHash: text("body_hash").notNull(),
    sentAtMs: integer("sent_at_ms").notNull(),
    tournamentId: integer("tournament_id"),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.requestId] })],
);

export const lobbyChatSenders = sqliteTable(
  "lobby_chat_senders",
  {
    accountId: text("account_id"),
    publicId: text("public_id").notNull(),
    lastSentAtMs: integer("last_sent_at_ms")
      .notNull()
      .default(sql`0`),
    stopped: integer("stopped")
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    primaryKey({ columns: [t.accountId] }),
    unique("lobby_chat_senders_public_id_unique").on(t.publicId),
  ],
);

export const lobbyChatSettings = sqliteTable(
  "lobby_chat_settings",
  {
    id: integer("id"),
    accepting: integer("accepting")
      .notNull()
      .default(sql`1`),
  },
  (t) => [primaryKey({ columns: [t.id] }), check("lobby_chat_settings_check_1", sql`id=1`)],
);

export const reports = sqliteTable(
  "reports",
  {
    id: text("id").notNull(),
    roomId: text("room_id").notNull(),
    instanceId: text("instance_id").notNull(),
    messageId: text("message_id").notNull(),
    senderId: text("sender_id").notNull(),
    senderName: text("sender_name").notNull(),
    body: text("body").notNull(),
    sentAtMs: integer("sent_at_ms").notNull(),
    reporterHash: text("reporter_hash").notNull(),
    reportedAtMs: integer("reported_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    status: text("status")
      .notNull()
      .default(sql`'open'`),
    action: text("action"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    unique("reports_instance_id_message_id_reporter_hash_unique").on(
      t.instanceId,
      t.messageId,
      t.reporterHash,
    ),
    index("reports_order").on(sql`${t.reportedAtMs} desc`, sql`${t.id} desc`),
    index("reports_expiry").on(t.expiresAtMs),
    index("reports_reporter_time").on(t.instanceId, t.reporterHash, sql`${t.reportedAtMs} desc`),
    check("reports_check_1", sql`status IN ('open', 'resolved')`),
  ],
);
