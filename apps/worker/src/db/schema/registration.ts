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

export const registrationFlows = sqliteTable(
  "registration_flows",
  {
    id: text("id").notNull(),
    secretHash: text("secret_hash").notNull(),
    roomId: text("room_id").notNull(),
    instanceId: text("instance_id").notNull(),
    matchId: text("match_id").notNull(),
    playerId: text("player_id"),
    oldTokenHash: text("old_token_hash").notNull(),
    newTokenHash: text("new_token_hash").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    holdUntilMs: integer("hold_until_ms").notNull(),
    claimUntilMs: integer("claim_until_ms").notNull(),
    accountId: text("account_id"),
    sessionId: text("session_id"),
    cancelledAtMs: integer("cancelled_at_ms"),
    recordAcceptedAtMs: integer("record_accepted_at_ms"),
    seatState: text("seat_state")
      .notNull()
      .default(sql`'held'`),
    guestAccountId: text("guest_account_id"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("registration_flows_account").on(t.accountId),
    index("registration_flows_expiry").on(t.claimUntilMs),
  ],
);

export const registrationOauthStates = sqliteTable(
  "registration_oauth_states",
  {
    state: text("state").notNull(),
    registrationId: text("registration_id")
      .notNull()
      .references(() => registrationFlows.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.state] }),
    index("registration_oauth_flow").on(t.registrationId),
  ],
);

export const matchParticipantAccounts = sqliteTable(
  "match_participant_accounts",
  {
    matchId: text("match_id").notNull(),
    playerId: text("player_id").notNull(),
    accountId: text("account_id"),
    roomId: text("room_id").notNull(),
    instanceId: text("instance_id").notNull(),
    state: text("state").notNull(),
    acceptedAtMs: integer("accepted_at_ms").notNull(),
    retryAtMs: integer("retry_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.playerId] }),
    unique("match_participant_accounts_match_id_account_id_unique").on(t.matchId, t.accountId),
    index("match_participant_accounts_pending").on(t.state, t.retryAtMs),
    index("match_participant_accounts_account").on(t.accountId),
    check(
      "match_participant_accounts_check_1",
      sql`state IN ('pending', 'applied', 'retired', 'rejected')`,
    ),
    check(
      "match_participant_accounts_check_2",
      sql`(state IN ('retired','rejected') AND account_id IS NULL) OR (state IN ('pending','applied') AND account_id IS NOT NULL)`,
    ),
  ],
);
