import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { roomParticipantScrubSql } from "../src/adapters/room/indexScrub";
import * as schema from "../src/db/schema";
import { inspectTable, tableNames } from "./schemaInspection";

const migrated = new Database(":memory:");
const defined = new Database(":memory:");
afterAll(() => {
  migrated.close();
  defined.close();
});

const migrations = new URL("../migrations/", import.meta.url);
const migrationFiles = readdirSync(migrations)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const migrationSql = (file: string) => readFileSync(new URL(file, migrations), "utf8");
function applyMigrations(db: Database) {
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationFiles) db.exec(migrationSql(file));
}
applyMigrations(migrated);

const current = await generateSQLiteDrizzleJson(schema);
const empty = await generateSQLiteDrizzleJson({});
const definition = await generateSQLiteMigration(empty, current);
const tableConfigs = Object.values(schema).map(getTableConfig);
const dialect = new SQLiteSyncDialect();
// drizzle-kit 0.31 は索引の式に含まれるカンマでも列を分割するため、該当する索引は Drizzle の列定義から組み立てます。
for (const table of tableConfigs) {
  for (const { config: index } of table.indexes) {
    const columns = index.columns.map(
      (column) => dialect.sqlToQuery(sql`${column}`, "indexes").sql,
    );
    if (!columns.some((column) => column.includes(","))) continue;
    const prefix = `CREATE ${index.unique ? "UNIQUE " : ""}INDEX \`${index.name}\` ON \`${table.name}\``;
    const position = definition.findIndex((statement) => statement.startsWith(prefix + " ("));
    expect(position).toBeGreaterThanOrEqual(0);
    const where = index.where ? ` WHERE ${dialect.sqlToQuery(index.where).sql}` : "";
    definition[position] = `${prefix} (${columns.join(", ")})${where};`;
  }
}
for (const statement of definition) defined.exec(statement);

// KitはUNIQUE制約を一意索引として出力するため、SQLiteの自動名と対応づけます。
const uniqueNames = new Set(
  tableConfigs
    .flatMap(({ uniqueConstraints }) => uniqueConstraints.map((constraint) => constraint.getName()))
    .filter((name) => name !== undefined),
);

test("全 migration の 71 テーブルを適用します", () => {
  expect(tableNames(migrated)).toHaveLength(71);
  expect(tableNames(defined)).toEqual(tableNames(migrated));
});

test("掲示板の投稿受付は migration の適用直後に停止しています", () => {
  expect(migrated.query("SELECT id,accepting FROM board_settings").all()).toEqual([
    { id: 1, accepting: 0 },
  ]);
});

test("初期のお知らせの公開日を全 migration 適用後も保持します", () => {
  expect(
    migrated.query("SELECT published_on FROM announcements WHERE id='feedback'").get(),
  ).toEqual({ published_on: "2026-10-04" });
});

test("日付だけ更新された記事を移行し、掲載先と既存の通知を保持します", () => {
  const db = new Database(":memory:");
  try {
    applyMigrations(db);
    db.exec(`
      INSERT INTO announcement_lobby_targets VALUES ('feedback', 'four-reversi'), ('feedback', 'four-shogi');
    `);
    const events = db.query("SELECT * FROM notification_events WHERE source_id = 'feedback'").all();
    expect(events).toHaveLength(1);
    db.exec(
      "UPDATE announcements SET published_on = '2026-11-19', version = 2 WHERE id = 'feedback'",
    );

    expect(
      db
        .query("SELECT published_on, published, version FROM announcements WHERE id = 'feedback'")
        .get(),
    ).toEqual({ published_on: "2026-11-19", published: 1, version: 2 });
    const targets = db.query(
      "SELECT game FROM announcement_lobby_targets WHERE announcement_id = 'feedback' ORDER BY game",
    );
    expect(targets.all()).toEqual([{ game: "four-reversi" }, { game: "four-shogi" }]);
    expect(
      db.query("SELECT * FROM notification_events WHERE source_id = 'feedback'").all(),
    ).toEqual(events);
    expect(db.query("PRAGMA foreign_key_check(announcement_lobby_targets)").all()).toEqual([]);

    db.exec("DELETE FROM announcements WHERE id = 'feedback'");
    expect(targets.all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("0057 はお知らせの date を削除し、残りの列とロビー掲載先を保持します", () => {
  const db = new Database(":memory:");
  try {
    applyMigrations(db);
    db.exec(`
      UPDATE announcements SET version = 2, published_on = '2026-11-19' WHERE id = 'feedback';
      INSERT INTO announcements (id, title, body, kind, published, created_at_ms, updated_at_ms, version, published_on)
      VALUES ('draft', '下書き', '本文', 'tournament', 0, 100, 200, 3, '2026-11-20');
      INSERT INTO announcement_lobby_targets (announcement_id, game)
      VALUES ('feedback', 'four-reversi'), ('feedback', 'four-shogi'), ('draft', 'four-shogi');
    `);
    const announcementsBefore = db
      .query(
        "SELECT id, title, body, kind, published, created_at_ms, updated_at_ms, version, published_on FROM announcements ORDER BY id",
      )
      .all();
    const lobbyTargetsSql =
      "SELECT * FROM announcement_lobby_targets ORDER BY announcement_id, game";
    const lobbyTargetsBefore = db.query(lobbyTargetsSql).all();
    expect(announcementsBefore).toHaveLength(2);
    expect(lobbyTargetsBefore).toHaveLength(3);

    expect(db.query("SELECT * FROM announcements ORDER BY id").all()).toEqual(announcementsBefore);
    expect(db.query("PRAGMA table_info(announcements)").all()).not.toContainEqual(
      expect.objectContaining({ name: "date" }),
    );
    expect(db.query(lobbyTargetsSql).all()).toEqual(lobbyTargetsBefore);
    expect(db.query("PRAGMA foreign_key_check(announcement_lobby_targets)").all()).toEqual([]);
    db.exec("DELETE FROM announcements WHERE id = 'feedback'");
    expect(db.query(lobbyTargetsSql).all()).toEqual([
      { announcement_id: "draft", game: "four-shogi" },
    ]);
  } finally {
    db.close();
  }
});

test("閉鎖・観測時刻は NULL を許容し、閉鎖行だけに期限走査用の索引を持つ", () => {
  const columns = migrated
    .query<{ name: string; notnull: number; dflt_value: null }, []>("PRAGMA table_info(room_index)")
    .all();
  for (const name of ["closed_at_ms", "closed_observed_at_ms"])
    expect(columns.find((column) => column.name === name)).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
  expect(migrated.query("PRAGMA index_list(room_index)").all()).toContainEqual(
    expect.objectContaining({ name: "room_index_closed_retention", partial: 1 }),
  );
});

test.each([
  "tournament_score_apply",
  "matchmaking_room_fence",
  "tournament_room_fence",
  "matchmaking_wait_fence",
  "matchmaking_tournament_fence",
  "tournament_wait_fence",
  "guest_merge_fence",
  "matchmaking_guest_merge_fence",
  "guest_promotion_fence",
  "matchmaking_login_transition_fence",
  "guest_room_link_commit_fence",
  "guest_merged_seat_fence",
  "guest_merged_wait_fence",
  "guest_merged_entry_fence",
  "registration_deleted_account_insert",
  "registration_deleted_account_update",
  "guest_merged_match_insert",
  "guest_merged_upload_insert",
  "guest_merged_history_insert",
  "lobby_chat_accept",
  "notification_announcement_insert",
  "notification_announcement_publish",
  "notification_badge",
  "notification_privacy_insert",
  "notification_privacy_update",
  "notification_reads_privacy",
  "notification_state_privacy",
  "privacy_challenge_limit",
  "privacy_fence_account_badge_awards",
  "privacy_fence_account_badge_notifications",
  "privacy_fence_account_match_history",
  "privacy_fence_account_room_seats",
  "privacy_fence_feedback",
  "privacy_fence_match_claim_insert",
  "privacy_fence_match_claim_update",
  "privacy_fence_privacy_room_accounts",
  "privacy_fence_room_players",
  "privacy_hide_feedback",
  "privacy_hide_room_index",
  "privacy_hide_room_participants",
  "privacy_pending_images",
  "privacy_retire_match_claims",
  "privacy_scrub_claimed_match_insert",
  "privacy_scrub_claimed_match_update",
  "privacy_scrub_claimed_upload_insert",
  "privacy_scrub_claimed_upload_update",
  "privacy_scrub_existing",
  "privacy_scrub_matches_insert",
  "privacy_scrub_matches_update",
  "privacy_scrub_retired_match_claim",
  "privacy_scrub_room_index_insert",
  "privacy_scrub_room_index_update",
  "privacy_scrub_room_participants_insert",
  "privacy_scrub_room_participants_update",
  "privacy_scrub_shogi_match_uploads_insert",
  "privacy_scrub_shogi_match_uploads_update",
  "tournament_entry_deleted_fence",
])("アプリへ移したトリガー %s は残りません", (name) => {
  expect(
    migrated.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").all(name),
  ).toEqual([]);
});

test.each([
  ["privacy_fence_account", "account"],
  ["privacy_fence_account_update", "account"],
  ["privacy_fence_session", "session"],
  ["privacy_fence_user_update", "user"],
])("better-auth の退会フェンス %s を残します", (name, table) => {
  expect(
    migrated.query("SELECT tbl_name FROM sqlite_master WHERE type='trigger' AND name=?").get(name),
  ).toEqual({ tbl_name: table });
});

test("参加者の伏せ字はルーム・世代・プレイヤーの索引を使います", () => {
  const { needed } = roomParticipantScrubSql(
    "room_index.room_id",
    "room_index.instance_id",
    "room_index.participants_json",
  );
  const plan = migrated
    .query<{ detail: string }, []>(
      `EXPLAIN QUERY PLAN SELECT room_id FROM room_index WHERE ${needed}`,
    )
    .all()
    .map(({ detail }) => detail);
  expect(plan).toContainEqual(
    expect.stringMatching(
      /\bprivacy_room_players_by_room_player\b \(room_id=\? AND instance_id=\? AND player_id=\?\)/,
    ),
  );
});

for (const table of tableNames(migrated)) {
  test(`${table}: 列・主キー・UNIQUE・索引・外部キー・CHECKが一致します`, () => {
    expect(inspectTable(defined, table, uniqueNames)).toEqual(inspectTable(migrated, table));
  });
}

test("保存したスナップショットから変更なしになります", async () => {
  const meta = new URL("../drizzle/meta/", import.meta.url);
  const journal = JSON.parse(readFileSync(new URL("_journal.json", meta), "utf8"));
  const latest = journal.entries.at(-1);
  const filename = `${String(latest.idx).padStart(4, "0")}_snapshot.json`;
  const baseline = JSON.parse(readFileSync(new URL(filename, meta), "utf8"));
  expect(await generateSQLiteMigration(baseline, current)).toEqual([]);
});

test.each([
  ["INTEGER PRIMARY KEY", true],
  ["INTEGER PRIMARY KEY AUTOINCREMENT", true],
  ["INTEGER", false],
  ["INT PRIMARY KEY", false],
  ["TEXT PRIMARY KEY", false],
  ["INTEGER PRIMARY KEY DESC", false],
] as const)("%s: rowidの別名だけnotnullを正規化します", (declaration, isRowid) => {
  const implicit = new Database(":memory:");
  const explicit = new Database(":memory:");
  try {
    implicit.exec(`CREATE TABLE sample (id ${declaration})`);
    explicit.exec(`CREATE TABLE sample (id ${declaration} NOT NULL)`);
    const implicitColumns = inspectTable(implicit, "sample").columns;
    const explicitColumns = inspectTable(explicit, "sample").columns;
    if (isRowid) expect(implicitColumns).toEqual(explicitColumns);
    else expect(implicitColumns).not.toEqual(explicitColumns);
  } finally {
    implicit.close();
    explicit.close();
  }
});
