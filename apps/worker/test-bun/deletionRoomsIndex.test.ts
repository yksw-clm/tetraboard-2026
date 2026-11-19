import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { roomDeletionQuery } from "../src/adapters/privacy/roomDeletionQuery";

const migrations = new URL("../migrations/", import.meta.url);

test("ルームの退会確認は deletion_rooms_by_room で検索する", () => {
  using db = new Database(":memory:");
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(file, migrations), "utf8"));

  const plan = db
    .query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${roomDeletionQuery}`)
    .all("ROOM")
    .map(({ detail }) => detail);
  expect(plan).toEqual([
    expect.stringMatching(
      /^SEARCH deletion_rooms USING COVERING INDEX deletion_rooms_by_room \(room_id=\?\)$/,
    ),
  ]);
});
