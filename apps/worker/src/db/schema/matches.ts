import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const matches = sqliteTable(
  "matches",
  {
    id: text("id").notNull(),
    game: text("game").notNull(),
    mode: text("mode").notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
    endedAtMs: integer("ended_at_ms").notNull(),
    recordJson: text("record_json").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("matches_game_recent").on(t.game, sql`${t.startedAtMs} desc`, sql`${t.id} desc`),
    index("matches_recent").on(sql`${t.startedAtMs} desc`, sql`${t.id} desc`),
  ],
);

export const accountMatchHistory = sqliteTable(
  "account_match_history",
  {
    accountId: text("account_id").notNull(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id),
    mode: text("mode").notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
    game: text("game")
      .notNull()
      .default(sql`'four-reversi'`),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.matchId] }),
    index("account_match_history_page").on(
      t.accountId,
      t.mode,
      sql`${t.startedAtMs} desc`,
      sql`${t.matchId} desc`,
    ),
    index("account_match_history_game_page").on(
      t.accountId,
      t.game,
      t.mode,
      sql`${t.startedAtMs} desc`,
      sql`${t.matchId} desc`,
    ),
  ],
);

export const matchEventChunks = sqliteTable(
  "match_event_chunks",
  {
    matchId: text("match_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    startIndex: integer("start_index").notNull(),
    eventCount: integer("event_count").notNull(),
    eventsJson: text("events_json").notNull(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.chunkIndex] })],
);

export const matchUploads = sqliteTable(
  "match_uploads",
  {
    id: text("id").notNull(),
    recordJson: text("record_json").notNull(),
    eventCount: integer("event_count").notNull(),
    chunkCount: integer("chunk_count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const fourShogiFormationUsages = sqliteTable(
  "four_shogi_formation_usages",
  {
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    analyzerId: text("analyzer_id").notNull(),
    analysisVersion: integer("analysis_version").notNull(),
    rulesVersion: integer("rules_version").notNull(),
    usedBySideJson: text("used_by_side_json").notNull(),
  },
  (t) => [primaryKey({ columns: [t.matchId] })],
);
