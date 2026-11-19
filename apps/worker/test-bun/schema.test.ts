import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
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

test("既存migrationの全67テーブルと42トリガーを適用します", () => {
  expect(tableNames(migrated)).toHaveLength(67);
  expect(tableNames(defined)).toEqual(tableNames(migrated));
  expect(
    migrated.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all(),
  ).toHaveLength(42);
});

test("既存のお知らせの日付を published_on に引き継ぎます", () => {
  expect(
    migrated.query("SELECT published_on, date FROM announcements WHERE id='feedback'").get(),
  ).toEqual({ published_on: expect.any(String), date: expect.any(String) });
  expect(
    migrated.query("SELECT id FROM announcements WHERE published_on IS NOT date").all(),
  ).toEqual([]);
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
