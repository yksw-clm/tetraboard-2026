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

export const roomIndex = sqliteTable(
  "room_index",
  {
    roomId: text("room_id").notNull(),
    game: text("game").notNull(),
    mode: text("mode").notNull(),
    mainTimeMs: integer("main_time_ms").notNull(),
    byoyomiMs: integer("byoyomi_ms").notNull(),
    status: text("status").notNull(),
    hostName: text("host_name"),
    humanCount: integer("human_count").notNull(),
    cpuCount: integer("cpu_count").notNull(),
    capacity: integer("capacity").notNull(),
    openSeats: integer("open_seats").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    revision: integer("revision").notNull(),
    closed: integer("closed")
      .notNull()
      .default(sql`0`),
    hostAvatarUrl: text("host_avatar_url"),
    instanceId: text("instance_id"),
    hostPlayerId: text("host_player_id"),
    tournamentId: integer("tournament_id"),
    participantsJson: text("participants_json"),
    matchmaking: integer("matchmaking")
      .notNull()
      .default(sql`0`),
    matchKind: text("match_kind"),
    matchSequence: integer("match_sequence"),
  },
  (t) => [
    primaryKey({ columns: [t.roomId] }),
    index("room_index_public_order").on(
      t.closed,
      sql`${t.updatedAtMs} desc`,
      sql`${t.roomId} desc`,
    ),
    index("lobby_rooms_order").on(
      t.closed,
      t.status,
      sql`${t.updatedAtMs} desc`,
      sql`${t.roomId} desc`,
    ),
    check("room_index_check_1", sql`closed IN (0, 1)`),
    check("room_index_check_2", sql`match_kind IN ('rated', 'tournament', 'normal', 'unknown')`),
    check("room_index_check_3", sql`match_sequence BETWEEN 1 AND 9007199254740991`),
  ],
);

export const accountRoomSeats = sqliteTable(
  "account_room_seats",
  {
    accountId: text("account_id").notNull(),
    operationId: text("operation_id").notNull(),
    roomId: text("room_id").notNull(),
    instanceId: text("instance_id").notNull(),
    playerId: text("player_id").notNull(),
    name: text("name").notNull(),
    avatarKey: text("avatar_key"),
    createdAtMs: integer("created_at_ms").notNull(),
    checkedAtMs: integer("checked_at_ms")
      .notNull()
      .default(sql`0`),
    avatarPresetId: text("avatar_preset_id"),
  },
  (t) => [
    primaryKey({ columns: [t.accountId] }),
    unique("account_room_seats_operation_id_unique").on(t.operationId),
  ],
);

export const roomAvatarRefs = sqliteTable(
  "room_avatar_refs",
  {
    operationId: text("operation_id").notNull(),
    roomId: text("room_id").notNull(),
    instanceId: text("instance_id").notNull(),
    playerId: text("player_id").notNull(),
    avatarKey: text("avatar_key").notNull(),
  },
  (t) => [primaryKey({ columns: [t.operationId] }), index("room_avatar_refs_key").on(t.avatarKey)],
);

export const roomMatchSequences = sqliteTable(
  "room_match_sequences",
  {
    matchId: text("match_id").notNull(),
    scope: text("scope").notNull(),
    sequence: integer("sequence").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId] }),
    unique("room_match_sequences_scope_sequence_unique").on(t.scope, t.sequence),
    check("room_match_sequences_check_1", sql`sequence BETWEEN 1 AND 9007199254740991`),
  ],
);

export const matchmakingWaitReservations = sqliteTable(
  "matchmaking_wait_reservations",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => user.id),
    queueKey: text("queue_key").notNull(),
    operationId: text("operation_id").notNull(),
    leaseUntilMs: integer("lease_until_ms").notNull(),
    matchOperationId: text("match_operation_id"),
  },
  (t) => [
    primaryKey({ columns: [t.accountId] }),
    unique("matchmaking_wait_reservations_operation_id_unique").on(t.operationId),
  ],
);
