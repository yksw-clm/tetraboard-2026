import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import { planSnapshotMatches, readMatchExport, type ExportRow } from "../scripts/snapshotMatchPlan";
import { sqlBytes, sqlLiteral } from "../scripts/snapshotMatchSql";
import { encodeSnapshotMatch, type SnapshotMatch } from "../src/rooms/snapshotMatchEvents";
import { readStoredMatch } from "../src/accounts/matchDataContracts";
import { snapshotRecord } from "../src/rooms/eventRecord";
import { accountFixture } from "./accountFixtures";
import { boundaryRequest } from "./roomBoundaryFixtures";
import { snapshotConversionFixtures as fixtures, exportRow } from "./snapshotConversionFixtures";

const ids = new Set<string>();
afterEach(async () => {
  for (const id of ids) {
    await env.APP_DB.prepare("DELETE FROM match_event_chunks WHERE match_id = ?")
      .bind(`tb-106-rollback:${id}`)
      .run();
    for (const [table, column] of [
      ["account_match_history", "match_id"],
      ["match_event_chunks", "match_id"],
      ["matches", "id"],
    ])
      await env.APP_DB.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(id).run();
  }
  ids.clear();
});
async function insert(row: ExportRow, userId?: string) {
  ids.add(row.id);
  const record = JSON.parse(row.record_json);
  const mode = record.settings.mode ?? "standard";
  await env.APP_DB.prepare("INSERT INTO matches VALUES (?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.game, mode, record.startedAtMs, record.endedAtMs, row.record_json)
    .run();
  if (userId)
    await env.APP_DB.prepare("INSERT INTO account_match_history VALUES (?, ?, ?, ?, ?)")
      .bind(userId, row.id, mode, record.startedAtMs, row.game)
      .run();
}
async function stored(id: string) {
  const row = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
    .bind(id)
    .first<{ record_json: string }>();
  return JSON.parse(row!.record_json);
}
async function responses(id: string, cookie: string) {
  const result = [];
  for (const path of [`/matches/${id}`, `/account/matches/${id}`]) {
    const response = await boundaryRequest(path, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    result.push(await response.json());
  }
  return result;
}
async function detailAndHistory(row: ExportRow, cookie: string) {
  const mode = JSON.parse(row.record_json).settings.mode ?? "standard";
  const result = await responses(row.id, cookie);
  for (const path of [
    `/matches?game=${row.game}`,
    `/account/matches?game=${row.game}&mode=${mode}`,
  ]) {
    const response = await boundaryRequest(path, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { matches: { id: string }[] };
    expect(body.matches).toEqual(expect.arrayContaining([expect.objectContaining({ id: row.id })]));
    result.push(body);
  }
  return result;
}
function statements(sql: string): string[] {
  // 生成SQLは値の中に改行を入れず、1文を1行にします。単引用符内のセミコロンも分割しません。
  return sql.trim().split("\n");
}
async function execute(sql: string) {
  // Wranglerのファイル実行と同様にbindを使わず、文の間にトランザクションを仮定しません。
  for (const statement of statements(sql)) await env.APP_DB.prepare(statement).run();
}
function conversion(row: ExportRow) {
  const plan = planSnapshotMatches([row]);
  expect(plan.report.failed).toEqual([]);
  return { ...plan, sql: plan.files["batch-001.sql"], rollback: plan.files["rollback-001.sql"] };
}

for (const fixture of fixtures) {
  test(`${fixture.name}: SQL変換・再実行・rollbackで公開と本人詳細を保持する`, async () => {
    const user = await accountFixture();
    const row = exportRow(fixture.json.replaceAll("fixture-self", user.id));
    await insert(row, user.id);
    const expected = await responses(row.id, user.cookie);
    const original = await stored(row.id);
    const { sql, rollback } = conversion(row);
    await execute(sql);
    const converted = await stored(row.id);
    expect(converted.replay).toMatchObject({
      format: "events",
      eventCount: original.replay.steps.length,
    });
    const chunks = await env.APP_DB.prepare(
      "SELECT event_count FROM match_event_chunks WHERE match_id = ? ORDER BY chunk_index",
    )
      .bind(row.id)
      .all<{ event_count: number }>();
    expect(chunks.results.map(({ event_count }) => event_count)).toEqual(
      Array.from({ length: Math.ceil(original.replay.steps.length / 100) }, (_, i) =>
        Math.min(100, original.replay.steps.length - i * 100),
      ),
    );
    expect(await responses(row.id, user.cookie)).toEqual(expected);
    await execute(sql);
    expect(await stored(row.id)).toEqual(converted);
    expect(await responses(row.id, user.cookie)).toEqual(expected);
    expect(statements(rollback).every((statement) => sqlBytes(statement) <= 100_000)).toBe(true);
    await execute(rollback);
    expect((await stored(row.id)).replay).toEqual(original.replay);
    expect(await responses(row.id, user.cookie)).toEqual(expected);
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM match_event_chunks WHERE match_id = ?")
        .bind(row.id)
        .first(),
    ).toBeNull();
    await execute(rollback);
    expect(await stored(row.id)).toEqual(original);
  });
}

test("大きな棋譜の全中断点で旧APIを保ち、全体の再実行で復旧する", async () => {
  const user = await accountFixture();
  const row = exportRow(
    fixtures
      .find((fixture) => fixture.name.includes("singles-full"))!
      .json.replaceAll("fixture-self", user.id),
  );
  expect(sqlBytes(row.record_json)).toBeGreaterThan(100_000);
  await insert(row, user.id);
  const expected = await responses(row.id, user.cookie);
  const original = await stored(row.id);
  const { sql, rollback } = conversion(row);
  for (let stop = 1; stop < statements(sql).length; stop++) {
    await execute(statements(sql).slice(0, stop).join("\n"));
    expect((await stored(row.id)).replay).toEqual(original.replay);
    expect(await responses(row.id, user.cookie)).toEqual(expected);
    await execute(sql);
    expect(await responses(row.id, user.cookie)).toEqual(expected);
    // 戻し途中からの再実行も、重複したstepsを作りません。
    await execute(statements(rollback).slice(0, 2).join("\n"));
    await execute(rollback);
    expect((await stored(row.id)).replay).toEqual(original.replay);
  }
});

for (const fixture of fixtures.filter(
  ({ json }, index) => index === 0 || JSON.parse(json).replay.steps.length > 100,
)) {
  const planned = planSnapshotMatches([exportRow(fixture.json)]);
  const commandCount = statements(planned.files["rollback-001.sql"]).length;
  for (let stop = 1; stop <= commandCount; stop++) {
    test(`${fixture.name}: rollbackの${stop}/${commandCount}文後でも詳細・履歴を読め、再実行で作業行も消える`, async () => {
      const user = await accountFixture();
      const record = JSON.parse(fixture.json.replaceAll("fixture-self", user.id));
      const duration = record.endedAtMs - record.startedAtMs;
      // 共有DBの他局で先頭20件が埋まっても、対象局を含む履歴ページを検証します。
      record.startedAtMs = Date.UTC(2099, 0, 1);
      record.endedAtMs = record.startedAtMs + duration;
      const row = exportRow(JSON.stringify(record));
      await insert(row, user.id);
      const original = await stored(row.id);
      const { sql, rollback } = conversion(row);
      await execute(sql);
      const expected = await detailAndHistory(row, user.cookie);
      const commands = statements(rollback);
      const publication = commands.findIndex((command) => command.startsWith("UPDATE matches SET"));
      expect(publication).toBeGreaterThan(2);
      await execute(commands.slice(0, stop).join("\n"));
      if (stop <= publication) expect((await stored(row.id)).replay.format).toBe("events");
      expect(await detailAndHistory(row, user.cookie)).toEqual(expected);
      await execute(rollback);
      expect((await stored(row.id)).replay).toEqual(original.replay);
      expect(
        await env.APP_DB.prepare("SELECT 1 FROM match_event_chunks WHERE match_id IN (?, ?)")
          .bind(row.id, `tb-106-rollback:${row.id}`)
          .first(),
      ).toBeNull();
      expect(await detailAndHistory(row, user.cookie)).toEqual(expected);
    });
  }
}

test("書き出し後の退会とゲスト引き継ぎを変換とrollbackで保持する", async () => {
  const retired = await accountFixture();
  const guest = await accountFixture();
  const registered = await accountFixture();
  const raw = JSON.parse(fixtures[0].json.replaceAll("fixture-self", retired.id));
  raw.participants[0].accountId = retired.id;
  raw.participants[1].accountId = guest.id;
  const row = exportRow(JSON.stringify(raw));
  await insert(row);
  const { sql, rollback } = conversion(row);
  await env.APP_DB.prepare(
    "INSERT INTO deleted_accounts (id, requested_at_ms, receipt_hash) VALUES (?, 1, ?)",
  )
    .bind(retired.id, crypto.randomUUID())
    .run();
  await env.APP_DB.prepare(`UPDATE matches SET record_json=json_set(record_json,'$.participants',json((
    SELECT json_group_array(json(CASE WHEN json_extract(p.value,'$.accountId')=? THEN json_set(p.value,'$.accountId',?) ELSE p.value END))
    FROM json_each(matches.record_json,'$.participants') p))) WHERE id=?`)
    .bind(guest.id, registered.id, row.id)
    .run();
  const participants = (await stored(row.id)).participants;
  expect(participants[0]).toMatchObject({
    name: "退会したプレイヤー",
    accountId: null,
    retired: true,
  });
  expect(participants[1].accountId).toBe(registered.id);
  await execute(sql);
  expect((await stored(row.id)).participants).toEqual(participants);
  await execute(rollback);
  expect((await stored(row.id)).participants).toEqual(participants);
});

test("手数が変わった局とeventCountが違う局への適用は何も変更しない", async () => {
  const row = exportRow(fixtures[0].json);
  await insert(row);
  const { sql, rollback } = conversion(row);
  const changed = JSON.parse(row.record_json);
  changed.replay.steps.pop();
  await env.APP_DB.prepare("UPDATE matches SET record_json=? WHERE id=?")
    .bind(JSON.stringify(changed), row.id)
    .run();
  await execute(sql);
  expect(await stored(row.id)).toEqual(changed);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM match_event_chunks WHERE match_id=?")
      .bind(row.id)
      .first(),
  ).toBeNull();
  changed.replay = { format: "events", eventCount: 999 };
  await env.APP_DB.prepare("UPDATE matches SET record_json=? WHERE id=?")
    .bind(JSON.stringify(changed), row.id)
    .run();
  await execute(rollback);
  expect(await stored(row.id)).toEqual(changed);
});

test("除外・失敗・複数入力・batch・SQLのバイト上限を報告する", () => {
  const rows = fixtures.map(({ json }) => exportRow(json));
  const match = readStoredMatch(rows[0].record_json, rows[0].game);
  if (match.game === "shogi" || match.game === "four-shogi") throw new Error("Unexpected game");
  const events = encodeSnapshotMatch(snapshotRecord<SnapshotMatch>(match.record)).record;
  const eventRow = exportRow(JSON.stringify({ ...events, id: crypto.randomUUID() }));
  const shogi = ["shogi", "four-shogi"].map((game) => ({
    id: crypto.randomUUID(),
    game,
    record_json: "{}",
  }));
  const tampered = JSON.parse(rows[1].record_json);
  tampered.id = crypto.randomUUID();
  tampered.replay.id = tampered.id;
  tampered.replay.steps[0].game.moveNumber++;
  const bad = exportRow(JSON.stringify(tampered));
  const plan = planSnapshotMatches([...rows, eventRow, ...shogi, bad], { batchSize: 3 });
  expect(plan.report.converted).toHaveLength(11);
  expect(plan.report.batches.map(({ ids }) => ids.length)).toEqual([3, 3, 3, 2]);
  expect(plan.report.skipped.map(({ reason }) => reason)).toEqual([
    "already-events",
    "shogi",
    "shogi",
  ]);
  expect(plan.report.failed).toEqual([
    expect.objectContaining({
      id: bad.id,
      reason: "Match event replay does not match saved steps",
    }),
  ]);
  expect(Object.values(plan.files).join("\n")).not.toContain(bad.id);
  expect(planSnapshotMatches([rows[0]], { statementLimit: 100 }).report.failed[0].reason).toContain(
    "SQL statement",
  );
  expect(
    readMatchExport([{ results: rows.slice(0, 2), success: true }, { results: rows.slice(2) }]),
  ).toEqual(rows);
  expect(() => readMatchExport([{ results: [], success: false }])).toThrow();
  expect(
    planSnapshotMatches([rows[0], { ...rows[0], record_json: "{}" }]).report.failed[0].reason,
  ).toContain("duplicate");
  expect(sqlLiteral("日本語'値;--")).toBe("'日本語''値;--'");
  expect(() => sqlLiteral("line\nbreak")).toThrow();
  expect(sqlBytes("棋譜")).toBe(6);
});
