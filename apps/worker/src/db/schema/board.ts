import { gameIds } from "@tetraboard/protocol/games";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const boardPosts = sqliteTable(
  "board_posts",
  {
    id: text("id").primaryKey().notNull(),
    gameId: text("game_id", { enum: gameIds }).notNull(),
    parentId: text("parent_id").references((): AnySQLiteColumn => boardPosts.id),
    accountId: text("account_id"),
    body: text("body"),
    postedAtMs: integer("posted_at_ms").notNull(),
    deletedAtMs: integer("deleted_at_ms"),
    deletionReason: text("deletion_reason", { enum: ["author", "moderator", "withdrawn"] }),
    matchId: text("match_id"),
    position: integer("position"),
    requestId: text("request_id").notNull(),
    bodyHash: text("body_hash").notNull(),
  },
  (t) => [
    uniqueIndex("board_posts_account_request").on(t.accountId, t.requestId),
    index("board_posts_timeline")
      .on(t.gameId, sql`${t.postedAtMs} DESC`, sql`${t.id} DESC`)
      .where(sql`${t.parentId} IS NULL`),
    index("board_posts_replies").on(t.parentId, t.postedAtMs, t.id),
    index("board_posts_account").on(t.accountId),
    check(
      "board_posts_game",
      sql`game_id IN (${sql.join(
        gameIds.map((id) => sql.raw(`'${id}'`)),
        sql`, `,
      )})`,
    ),
    check("board_posts_body", sql`(deleted_at_ms IS NULL) = (body IS NOT NULL)`),
    check(
      "board_posts_deletion_reason",
      sql`deletion_reason IN ('author', 'moderator', 'withdrawn')`,
    ),
    check(
      "board_posts_attachment",
      sql`(match_id IS NULL AND position IS NULL) OR (match_id IS NOT NULL AND position IS NOT NULL AND position >= 0)`,
    ),
  ],
);

export const boardLikes = sqliteTable(
  "board_likes",
  {
    postId: text("post_id")
      .notNull()
      .references(() => boardPosts.id),
    accountId: text("account_id").notNull(),
    likedAtMs: integer("liked_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.accountId] }),
    index("board_likes_account").on(t.accountId),
  ],
);

export const boardSenders = sqliteTable("board_senders", {
  accountId: text("account_id").primaryKey().notNull(),
  lastPostedAtMs: integer("last_posted_at_ms").notNull().default(0),
  stopped: integer("stopped").notNull().default(0),
});

export const boardSettings = sqliteTable(
  "board_settings",
  {
    id: integer("id").primaryKey().notNull(),
    accepting: integer("accepting").notNull().default(0),
  },
  () => [check("board_settings_singleton", sql`id=1`)],
);
