import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { lobbyMatchesQuery } from "../src/adapters/record/lobbyMatchesQuery";

const db = new Database(":memory:");
afterAll(() => db.close());
const migrations = new URL("../migrations/", import.meta.url);
for (const file of readdirSync(migrations)
  .filter((name) => name.endsWith(".sql"))
  .sort())
  db.exec(readFileSync(new URL(file, migrations), "utf8"));

test.each([false, true])(
  "全ゲームの最近の対局は索引順に取得する（対人戦のみ: %s）",
  (humanOnly) => {
    const plan = db
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${lobbyMatchesQuery(humanOnly)}`)
      .all()
      .map(({ detail }) => detail);
    expect(plan).toEqual(
      expect.arrayContaining([expect.stringContaining("USING INDEX matches_recent")]),
    );
    expect(plan.join("\n")).not.toContain("USE TEMP B-TREE");
  },
);
