import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

export const deletedAccounts = sqliteTable(
  "deleted_accounts",
  {
    id: text("id"),
    requestedAtMs: integer("requested_at_ms").notNull(),
    completedAtMs: integer("completed_at_ms"),
    receiptHash: text("receipt_hash").notNull(),
    avatarKey: text("avatar_key"),
    provider: text("provider"),
    revocationToken: text("revocation_token"),
    lastAttemptedAtMs: integer("last_attempted_at_ms")
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    unique("deleted_accounts_receipt_hash_unique").on(t.receiptHash),
  ],
);

export const deletionChallenges = sqliteTable(
  "deletion_challenges",
  {
    id: text("id"),
    accountId: text("account_id").notNull(),
    provider: text("provider").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    verifiedAtMs: integer("verified_at_ms"),
    oauthState: text("oauth_state"),
    verifiedSessionId: text("verified_session_id"),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const deletionFlows = sqliteTable(
  "deletion_flows",
  {
    id: text("id"),
    accountId: text("account_id").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const deletionImages = sqliteTable(
  "deletion_images",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => deletedAccounts.id),
    key: text("key").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.key] })],
);

export const deletionRooms = sqliteTable(
  "deletion_rooms",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => deletedAccounts.id),
    roomId: text("room_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.roomId] }),
    index("deletion_rooms_by_room").on(t.roomId, t.accountId),
  ],
);

export const legalConsents = sqliteTable(
  "legal_consents",
  {
    accountId: text("account_id").references(() => user.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    acceptedAtMs: integer("accepted_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId] })],
);

export const oauthLegalConsents = sqliteTable(
  "oauth_legal_consents",
  {
    state: text("state"),
    provider: text("provider").notNull(),
    version: text("version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.state] })],
);

export const privacyAvatarUploads = sqliteTable(
  "privacy_avatar_uploads",
  {
    key: text("key"),
    accountId: text("account_id").notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.key] })],
);

export const privacyRoomAccounts = sqliteTable(
  "privacy_room_accounts",
  {
    accountId: text("account_id").notNull(),
    roomId: text("room_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.roomId] })],
);

export const privacyRoomPlayers = sqliteTable(
  "privacy_room_players",
  {
    accountId: text("account_id").notNull(),
    roomId: text("room_id").notNull(),
    instanceId: text("instance_id").notNull(),
    playerId: text("player_id").notNull(),
    avatarKey: text("avatar_key"),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.roomId, t.instanceId, t.playerId] })],
);
