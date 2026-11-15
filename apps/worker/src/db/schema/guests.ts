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
import { user } from "./auth";
import { registrationFlows } from "./registration";

export const guestAccountMerges = sqliteTable(
  "guest_account_merges",
  {
    guestId: text("guest_id").notNull(),
    accountId: text("account_id").notNull(),
    mergedAtMs: integer("merged_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guestId] }),
    check("guest_account_merges_check_1", sql`guest_id != account_id`),
  ],
);

export const guestOauthFlows = sqliteTable(
  "guest_oauth_flows",
  {
    state: text("state").notNull(),
    guestId: text("guest_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    guestTokenHash: text("guest_token_hash").notNull(),
    provider: text("provider").notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    targetId: text("target_id"),
    targetSessionId: text("target_session_id"),
    isNewTarget: integer("is_new_target")
      .notNull()
      .default(sql`0`),
    roomRegistrationId: text("room_registration_id"),
  },
  (t) => [primaryKey({ columns: [t.state] })],
);

export const guestPromotions = sqliteTable(
  "guest_promotions",
  {
    guestId: text("guest_id").notNull(),
    temporaryId: text("temporary_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    sessionId: text("session_id").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guestId] }),
    unique("guest_promotions_temporary_id_unique").on(t.temporaryId),
  ],
);

export const guestRoomLinkCommits = sqliteTable(
  "guest_room_link_commits",
  {
    registrationId: text("registration_id")
      .notNull()
      .references(() => registrationFlows.id, { onDelete: "cascade" }),
    guestId: text("guest_id").notNull(),
    targetId: text("target_id").notNull(),
    oauthState: text("oauth_state").notNull(),
    committedAtMs: integer("committed_at_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.registrationId] })],
);

export const guestSessions = sqliteTable(
  "guest_sessions",
  {
    tokenHash: text("token_hash").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAtMs: integer("expires_at_ms").notNull(),
    registeredAtMs: integer("registered_at_ms"),
  },
  (t) => [primaryKey({ columns: [t.tokenHash] }), index("guest_sessions_account").on(t.accountId)],
);
