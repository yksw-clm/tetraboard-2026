import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth";
import { matches } from "./matches";

export const shogiRatingChanges = sqliteTable(
  "shogi_rating_changes",
  {
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
    unique("shogi_rating_changes_account_id_rated_games_unique").on(t.accountId, t.ratedGames),
  ],
);

export const shogiRatingPending = sqliteTable(
  "shogi_rating_pending",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    matchId: text("match_id").notNull(),
    roomId: text("room_id"),
    instanceId: text("instance_id"),
  },
  (t) => [
    primaryKey({ columns: [t.accountId] }),
    index("shogi_rating_pending_match").on(t.matchId),
  ],
);

export const reversiRatingChanges = sqliteTable(
  "reversi_rating_changes",
  {
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
    unique("reversi_rating_changes_account_id_rated_games_unique").on(t.accountId, t.ratedGames),
  ],
);

export const reversiRatingPending = sqliteTable(
  "reversi_rating_pending",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    matchId: text("match_id").notNull(),
    roomId: text("room_id"),
    instanceId: text("instance_id"),
  },
  (t) => [
    primaryKey({ columns: [t.accountId] }),
    index("reversi_rating_pending_match").on(t.matchId),
  ],
);
