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

export const accountBadgeAwards = sqliteTable(
  "account_badge_awards",
  {
    accountId: text("account_id").notNull(),
    game: text("game").notNull(),
    badgeId: text("badge_id").notNull(),
    tier: integer("tier").notNull(),
    value: integer("value").notNull(),
    previousTier: integer("previous_tier").notNull(),
    matchId: text("match_id"),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.game, t.badgeId, t.tier] }),
    index("account_badge_awards_match").on(t.accountId, t.matchId),
    check("account_badge_awards_check_1", sql`game IN ('four-reversi', 'four-shogi')`),
    check("account_badge_awards_check_2", sql`tier BETWEEN 1 AND 3`),
    check("account_badge_awards_check_3", sql`previous_tier BETWEEN 0 AND 3`),
  ],
);

export const accountBadgeNotifications = sqliteTable(
  "account_badge_notifications",
  {
    accountId: text("account_id").notNull(),
    matchId: text("match_id").notNull(),
    game: text("game").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    shownAtMs: integer("shown_at_ms"),
    claimToken: text("claim_token"),
    claimUntilMs: integer("claim_until_ms"),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.matchId] }),
    index("account_badge_notifications_pending").on(t.accountId, t.shownAtMs, t.createdAtMs),
  ],
);

export const accountNotificationReads = sqliteTable(
  "account_notification_reads",
  {
    accountId: text("account_id").notNull(),
    notificationSeq: integer("notification_seq")
      .notNull()
      .references(() => notificationEvents.seq, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.notificationSeq] })],
);

export const accountNotificationState = sqliteTable(
  "account_notification_state",
  {
    accountId: text("account_id"),
    baselineSeq: integer("baseline_seq").notNull(),
    readAllSeq: integer("read_all_seq")
      .notNull()
      .default(sql`0`),
  },
  (t) => [primaryKey({ columns: [t.accountId] })],
);

export const notificationEvents = sqliteTable(
  "notification_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),
    sourceId: text("source_id").notNull(),
    accountId: text("account_id")
      .notNull()
      .default(sql`''`),
    createdAtMs: integer("created_at_ms").notNull(),
    payloadJson: text("payload_json")
      .notNull()
      .default(sql`'{}'`),
    legacy: integer("legacy")
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    unique("notification_events_kind_source_id_account_id_unique").on(
      t.kind,
      t.sourceId,
      t.accountId,
    ),
    index("notification_events_account").on(t.accountId, t.seq),
    check("notification_events_check_1", sql`kind IN ('announcement','tournament','badge')`),
  ],
);

export const notificationMetadata = sqliteTable(
  "notification_metadata",
  {
    key: text("key"),
    value: integer("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.key] })],
);
