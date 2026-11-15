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

export const tournaments = sqliteTable(
  "tournaments",
  {
    key: text("key").notNull(),
    publicId: integer("public_id"),
    name: text("name").notNull(),
    description: text("description")
      .notNull()
      .default(sql`''`),
    rulesDescription: text("rules_description")
      .notNull()
      .default(sql`''`),
    startsAtMs: integer("starts_at_ms"),
    endsAtMs: integer("ends_at_ms"),
    published: integer("published")
      .notNull()
      .default(sql`0`),
    version: integer("version")
      .notNull()
      .default(sql`1`),
    ruleVersion: integer("rule_version")
      .notNull()
      .default(sql`1`),
    finalizedAtMs: integer("finalized_at_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    chatAccepting: integer("chat_accepting")
      .notNull()
      .default(sql`1`),
    game: text("game")
      .notNull()
      .default(sql`'four-shogi'`),
    settingsJson: text("settings_json"),
  },
  (t) => [
    primaryKey({ columns: [t.key] }),
    unique("tournaments_public_id_unique").on(t.publicId),
    index("tournaments_schedule").on(t.published, t.startsAtMs, t.endsAtMs),
    index("tournaments_game_schedule").on(t.game, t.published, t.startsAtMs, t.publicId),
    check("tournaments_check_1", sql`rule_version IN (1,2)`),
    check("tournaments_check_2", sql`chat_accepting IN (0,1)`),
    check("tournaments_check_3", sql`game IN ('four-shogi','four-reversi','four-gomoku')`),
    check(
      "tournaments_check_4",
      sql`rule_version=1 OR (settings_json IS NOT NULL AND json_valid(settings_json) AND json_extract(settings_json,'$.game') IS game)`,
    ),
    check(
      "tournaments_check_5",
      sql`published = 0 OR (public_id > 0 AND starts_at_ms IS NOT NULL AND ends_at_ms > starts_at_ms)`,
    ),
  ],
);

export const tournamentEntries = sqliteTable(
  "tournament_entries",
  {
    id: text("id").notNull(),
    tournamentKey: text("tournament_key")
      .notNull()
      .references(() => tournaments.key),
    accountId: text("account_id"),
    enteredAtMs: integer("entered_at_ms").notNull(),
    deleted: integer("deleted")
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    unique("tournament_entries_tournament_key_account_id_unique").on(t.tournamentKey, t.accountId),
    index("tournament_entries_list").on(t.tournamentKey, t.enteredAtMs, t.id),
  ],
);

export const tournamentMatchPlayers = sqliteTable(
  "tournament_match_players",
  {
    matchId: text("match_id")
      .notNull()
      .references(() => tournamentMatches.id),
    entryId: text("entry_id")
      .notNull()
      .references(() => tournamentEntries.id),
    accountId: text("account_id"),
    playerId: text("player_id").notNull(),
    operationId: text("operation_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.entryId] }),
    unique("tournament_match_players_match_id_player_id_unique").on(t.matchId, t.playerId),
  ],
);

export const tournamentMatches = sqliteTable(
  "tournament_matches",
  {
    id: text("id").notNull(),
    tournamentKey: text("tournament_key")
      .notNull()
      .references(() => tournaments.key),
    roomId: text("room_id").notNull(),
    instanceId: text("instance_id").notNull(),
    phase: text("phase").notNull(),
    startedAtMs: integer("started_at_ms"),
    finishedAtMs: integer("finished_at_ms"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("tournament_matches_pending").on(t.tournamentKey, t.phase),
    check(
      "tournament_matches_check_1",
      sql`phase IN ('reserved','playing','saving','saved','aborted')`,
    ),
  ],
);

export const tournamentPointEvents = sqliteTable(
  "tournament_point_events",
  {
    matchId: text("match_id")
      .notNull()
      .references(() => tournamentMatches.id),
    entryId: text("entry_id")
      .notNull()
      .references(() => tournamentEntries.id),
    rank: integer("rank").notNull(),
    knockouts: integer("knockouts").notNull(),
    pointsUnits: integer("points_units").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.entryId] }),
    check("tournament_point_events_check_1", sql`rank BETWEEN 1 AND 4`),
    check("tournament_point_events_check_2", sql`knockouts BETWEEN 0 AND 3`),
    check("tournament_point_events_check_3", sql`points_units >= 0`),
  ],
);

export const tournamentScores = sqliteTable(
  "tournament_scores",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => tournamentEntries.id),
    tournamentKey: text("tournament_key")
      .notNull()
      .references(() => tournaments.key),
    pointsUnits: integer("points_units")
      .notNull()
      .default(sql`0`),
    games: integer("games")
      .notNull()
      .default(sql`0`),
    first: integer("first")
      .notNull()
      .default(sql`0`),
    second: integer("second")
      .notNull()
      .default(sql`0`),
    third: integer("third")
      .notNull()
      .default(sql`0`),
    fourth: integer("fourth")
      .notNull()
      .default(sql`0`),
    knockouts: integer("knockouts")
      .notNull()
      .default(sql`0`),
    rankSum: integer("rank_sum")
      .notNull()
      .default(sql`0`),
    finalRank: integer("final_rank"),
  },
  (t) => [
    primaryKey({ columns: [t.entryId] }),
    index("tournament_scores_ranking").on(
      t.tournamentKey,
      sql`${t.pointsUnits} desc`,
      sql`${t.knockouts} desc`,
    ),
  ],
);

export const tournamentWaitReservations = sqliteTable(
  "tournament_wait_reservations",
  {
    accountId: text("account_id").notNull(),
    tournamentKey: text("tournament_key")
      .notNull()
      .references(() => tournaments.key),
    operationId: text("operation_id").notNull(),
    leaseUntilMs: integer("lease_until_ms").notNull(),
    matchOperationId: text("match_operation_id"),
  },
  (t) => [
    primaryKey({ columns: [t.accountId] }),
    unique("tournament_wait_reservations_operation_id_unique").on(t.operationId),
  ],
);
