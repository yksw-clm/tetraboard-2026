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

export const fourReversiRatingChanges = sqliteTable(
  "four_reversi_rating_changes",
  {
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    muBefore: real("mu_before").notNull(),
    sigmaBefore: real("sigma_before").notNull(),
    muAfter: real("mu_after").notNull(),
    sigmaAfter: real("sigma_after").notNull(),
    ratedGames: integer("rated_games").notNull(),
    humanGames: integer("human_games").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.accountId] }),
    unique("four_reversi_rating_changes_account_id_rated_games_unique").on(
      t.accountId,
      t.ratedGames,
    ),
  ],
);

export const fourReversiRatingPending = sqliteTable(
  "four_reversi_rating_pending",
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
    index("four_reversi_rating_pending_match").on(t.matchId),
  ],
);

export const fourShogiRatingChanges = sqliteTable(
  "four_shogi_rating_changes",
  {
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    muBefore: real("mu_before").notNull(),
    sigmaBefore: real("sigma_before").notNull(),
    muAfter: real("mu_after").notNull(),
    sigmaAfter: real("sigma_after").notNull(),
    ratedGames: integer("rated_games").notNull(),
    humanGames: integer("human_games").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.accountId] }),
    unique("four_shogi_rating_changes_account_id_rated_games_unique").on(t.accountId, t.ratedGames),
  ],
);

export const fourShogiRatingPending = sqliteTable(
  "four_shogi_rating_pending",
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
    index("four_shogi_rating_pending_match").on(t.matchId),
  ],
);
