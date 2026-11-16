import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { matches } from "./matches";

export const eloRatingChanges = sqliteTable(
  "elo_rating_changes",
  {
    game: text("game", { enum: ["shogi", "reversi"] }).notNull(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ratingBefore: real("rating_before").notNull(),
    ratingAfter: real("rating_after").notNull(),
    ratedGames: integer("rated_games").notNull(),
    humanGames: integer("human_games").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.accountId] }),
    uniqueIndex("elo_rating_changes_account_id_game_rated_games_unique").on(
      t.accountId,
      t.game,
      t.ratedGames,
    ),
  ],
);

export const eloRatingPending = sqliteTable(
  "elo_rating_pending",
  {
    game: text("game", { enum: ["shogi", "reversi"] }).notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    matchId: text("match_id").notNull(),
    roomId: text("room_id"),
    instanceId: text("instance_id"),
  },
  (t) => [
    primaryKey({ columns: [t.game, t.accountId] }),
    index("elo_rating_pending_match").on(t.matchId),
  ],
);
