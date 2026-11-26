import { gameIds } from "@tetraboard/protocol/games";
import { boardReportReasons } from "@tetraboard/protocol/board";
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
    requestId: text("request_id"),
    bodyHash: text("body_hash"),
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
      "board_posts_replay",
      sql`deletion_reason IS 'withdrawn' OR (request_id IS NOT NULL AND body_hash IS NOT NULL)`,
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

export const boardReports = sqliteTable(
  "board_reports",
  {
    id: text("id").primaryKey().notNull(),
    // 投稿の削除と独立して証拠を7日間保存するため、外部キーは付けません。
    postId: text("post_id").notNull(),
    gameId: text("game_id", { enum: gameIds }).notNull(),
    parentId: text("parent_id"),
    authorAccountId: text("author_account_id"),
    authorName: text("author_name").notNull(),
    body: text("body").notNull(),
    postedAtMs: integer("posted_at_ms").notNull(),
    reason: text("reason").notNull(),
    reporterAccountId: text("reporter_account_id"),
    reportedAtMs: integer("reported_at_ms").notNull(),
    status: text("status", { enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
  },
  (t) => [
    uniqueIndex("board_reports_post_reporter").on(t.postId, t.reporterAccountId),
    index("board_reports_reported").on(sql`${t.reportedAtMs} DESC`, sql`${t.id} DESC`),
    index("board_reports_reporter_reported").on(t.reporterAccountId, t.reportedAtMs),
    index("board_reports_author").on(t.authorAccountId),
    check(
      "board_reports_reason",
      sql`reason IN (${sql.join(
        boardReportReasons.map((reason) => sql.raw(`'${reason}'`)),
        sql`, `,
      )})`,
    ),
    check("board_reports_status", sql`status IN ('open', 'resolved')`),
  ],
);
