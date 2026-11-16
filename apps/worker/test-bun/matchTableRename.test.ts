import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const migrations = new URL("../migrations/", import.meta.url);
function beforeRename() {
  const db = new Database(":memory:");
  for (const file of readdirSync(migrations)
    .filter((file) => file.endsWith(".sql") && file < "0048")
    .sort())
    db.exec(readFileSync(new URL(file, migrations), "utf8"));
  return db;
}
const rename = readFileSync(new URL("0048_generalize_match_tables.sql", migrations), "utf8");
test("0048: 既存の本体・イベント・保存待ち・戦型と索引を保持し、トリガーの参照も更新する", () => {
  const db = beforeRename();
  try {
    const record = JSON.stringify({
      participants: [{ kind: "human", accountId: "retiring", name: "旧名" }],
    });
    db.query("INSERT INTO matches VALUES ('match', 'four-shogi', 'singles', 1, 2, ?)").run(record);
    db.query("INSERT INTO shogi_match_chunks VALUES ('match', 0, 0, 1, ?)").run(
      '[{"type":"draw"}]',
    );
    db.query("INSERT INTO shogi_match_uploads VALUES ('pending', ?, 1, 1)").run(record);
    db.exec("INSERT INTO shogi_match_formations VALUES ('match', 'analyzer', 1, 1, '{}')");
    db.exec("CREATE INDEX preserved_chunks_start ON shogi_match_chunks(start_index)");
    const triggers = db
      .query("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all();
    db.exec(rename);
    expect(db.query("SELECT record_json FROM matches").get()).toEqual({ record_json: record });
    expect(db.query("SELECT * FROM match_event_chunks").get()).toEqual({
      match_id: "match",
      chunk_index: 0,
      start_index: 0,
      event_count: 1,
      events_json: '[{"type":"draw"}]',
    });
    expect(db.query("SELECT * FROM match_uploads").get()).toEqual({
      id: "pending",
      record_json: record,
      event_count: 1,
      chunk_count: 1,
    });
    expect(db.query("SELECT * FROM four_shogi_formation_usages").get()).toEqual({
      match_id: "match",
      analyzer_id: "analyzer",
      analysis_version: 1,
      rules_version: 1,
      used_by_side_json: "{}",
    });
    expect(
      db.query("SELECT tbl_name FROM sqlite_master WHERE name='preserved_chunks_start'").get(),
    ).toEqual({ tbl_name: "match_event_chunks" });
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),
    ).toEqual(triggers);
    const sql = db
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='trigger'")
      .all()
      .map(({ sql }) => sql)
      .join("\n");
    expect(sql).not.toMatch(/\bshogi_match_(?:chunks|uploads|formations)\b/);
    // 退会済みの保存待ちと、新たに届いた保存待ちの両方に既存の匿名化が働きます。
    db.exec(
      "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES ('retiring',3,'receipt')",
    );
    const restored = db
      .query<{ record_json: string }, []>("SELECT record_json FROM match_uploads")
      .get()!;
    expect(JSON.parse(restored.record_json).participants[0]).toMatchObject({
      accountId: null,
      name: "退会したプレイヤー",
      retired: true,
    });
    db.query("INSERT INTO match_uploads VALUES ('later', ?, 1, 1)").run(record);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM match_uploads WHERE json_extract(record_json,'$.participants[0].accountId') IS NULL",
        )
        .get(),
    ).toEqual({ n: 2 });
  } finally {
    db.close();
  }
});
