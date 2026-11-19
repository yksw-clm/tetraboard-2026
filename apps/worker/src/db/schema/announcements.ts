import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const announcements = sqliteTable(
  "announcements",
  {
    id: text("id"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    kind: text("kind").notNull(),
    published: integer("published")
      .notNull()
      .default(sql`0`),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    version: integer("version")
      .notNull()
      .default(sql`1`),
    publishedOn: text("published_on").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("announcements_published_on_order").on(
      sql`${t.publishedOn} desc`,
      sql`${t.createdAtMs} desc`,
      sql`${t.id} desc`,
    ),
    index("announcements_public_published_on_order").on(
      t.published,
      sql`${t.publishedOn} desc`,
      sql`${t.createdAtMs} desc`,
      sql`${t.id} desc`,
    ),
    check("announcements_check_1", sql`kind IN ('improvement', 'feature', 'tournament', 'other')`),
    check("announcements_check_2", sql`published IN (0, 1)`),
    check("announcements_check_3", sql`version >= 1`),
  ],
);

export const announcementLobbyTargets = sqliteTable(
  "announcement_lobby_targets",
  {
    announcementId: text("announcement_id")
      .notNull()
      .references(() => announcements.id, { onDelete: "cascade" }),
    game: text("game").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.announcementId, t.game] }),
    index("announcement_targets_game").on(t.game, t.announcementId),
  ],
);
