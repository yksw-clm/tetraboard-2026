import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { planSnapshotMatches } from "../scripts/snapshotMatchPlan";
import { sqlFunction } from "../scripts/snapshotMatchSql";
import { exportRow, snapshotConversionFixtures } from "../test/snapshotConversionFixtures";

// 生成側の組立てとは独立して、SQLリテラルを飛ばし、関数ごとに直接の引数を数えます。
function functionArguments(sql: string): { name: string; count: number }[] {
  const tokens = [...sql.matchAll(/'(?:''|[^'])*'|[a-zA-Z_][a-zA-Z_0-9]*|[^\s]/gu)].map(
    ([token]) => token,
  );
  const stack: { name: string; commas: number; content: boolean }[] = [];
  const functions: { name: string; count: number }[] = [];
  for (const [index, token] of tokens.entries()) {
    const parent = stack.at(-1);
    if (token === "(") {
      if (parent) parent.content = true;
      stack.push({ name: tokens[index - 1] ?? "", commas: 0, content: false });
    } else if (token === ")") {
      const frame = stack.pop();
      if (frame && /^json(?:_|$)/u.test(frame.name))
        functions.push({ name: frame.name, count: frame.content ? frame.commas + 1 : 0 });
    } else if (parent) {
      if (token === ",") parent.commas++;
      else parent.content = true;
    }
  }
  return functions;
}

test("SQL関数は32引数を許し、33引数以上を生成時に拒否する", () => {
  const args = Array.from({ length: 32 }, () => "'value,(''quoted'')'");
  expect(functionArguments(sqlFunction("json_insert", args))).toEqual([
    { name: "json_insert", count: 32 },
  ]);
  expect(() => sqlFunction("json_insert", [...args, "'extra'"])).toThrow(
    "exceeds 32 arguments (33)",
  );
  expect(functionArguments(`json_insert(${Array(41).fill("'value'").join(",")})`)[0].count).toBe(
    41,
  );
});

for (const fixture of snapshotConversionFixtures.filter(
  ({ json }, index) => index === 0 || JSON.parse(json).replay.steps.length > 100,
)) {
  test(`${fixture.name}: 全SQLの引数上限32を検査してD1で変換・戻しを実行する`, async () => {
    const row = exportRow(fixture.json);
    const original = JSON.parse(row.record_json);
    const { report, files } = planSnapshotMatches([row]);
    expect(report.failed).toEqual([]);
    const db = env.APP_DB;
    try {
      await db
        .prepare("INSERT INTO matches VALUES (?, ?, ?, ?, ?, ?)")
        .bind(
          row.id,
          row.game,
          original.settings.mode ?? "standard",
          original.startedAtMs,
          original.endedAtMs,
          row.record_json,
        )
        .run();
      const arities: { name: string; count: number }[] = [];
      for (const filename of ["batch-001.sql", "rollback-001.sql"]) {
        const fileArities: number[] = [];
        for (const sql of files[filename].trim().split("\n")) {
          const functions = functionArguments(sql);
          expect(functions.every(({ count }) => count <= 32)).toBe(true);
          arities.push(...functions);
          fileArities.push(...functions.map(({ count }) => count));
          await db.prepare(sql).run();
        }
        expect(Math.max(...fileArities)).toBe(filename.startsWith("batch") ? 3 : 31);
      }
      expect(Math.max(...arities.map(({ count }) => count))).toBe(31);
      const restored = await db
        .prepare("SELECT record_json FROM matches WHERE id = ?")
        .bind(row.id)
        .first<{ record_json: string }>();
      expect(JSON.parse(restored!.record_json).replay).toEqual(original.replay);
      expect(
        await db
          .prepare("SELECT 1 FROM match_event_chunks WHERE match_id IN (?, ?)")
          .bind(row.id, `tb-106-rollback:${row.id}`)
          .first(),
      ).toBeNull();
    } finally {
      await db.batch([
        db
          .prepare("DELETE FROM match_event_chunks WHERE match_id IN (?, ?)")
          .bind(row.id, `tb-106-rollback:${row.id}`),
        db.prepare("DELETE FROM matches WHERE id = ?").bind(row.id),
      ]);
    }
  });
}
