import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../src/db/schema";
import { inspectTable, tableNames } from "./schemaInspection";

const migrated = new Database(":memory:");
const defined = new Database(":memory:");
afterAll(() => {
  migrated.close();
  defined.close();
});

const migrations = new URL("../migrations/", import.meta.url);
for (const file of readdirSync(migrations)
  .filter((file) => file.endsWith(".sql"))
  .sort())
  migrated.exec(readFileSync(new URL(file, migrations), "utf8"));

const current = await generateSQLiteDrizzleJson(schema);
const empty = await generateSQLiteDrizzleJson({});
for (const statement of await generateSQLiteMigration(empty, current)) defined.exec(statement);

// KitはUNIQUE制約を一意索引として出力するため、SQLiteの自動名と対応づけます。
const uniqueNames = new Set(
  Object.values(schema)
    .flatMap((table) =>
      getTableConfig(table).uniqueConstraints.map((constraint) => constraint.getName()),
    )
    .filter((name) => name !== undefined),
);

test("既存migrationの全65テーブルと42トリガーを適用します", () => {
  expect(tableNames(migrated)).toHaveLength(65);
  expect(tableNames(defined)).toEqual(tableNames(migrated));
  expect(
    migrated.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all(),
  ).toHaveLength(42);
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
])("アプリへ移したトリガー %s は残りません", (name) => {
  expect(
    migrated.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").all(name),
  ).toEqual([]);
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
