import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import { reversiArchives } from "../../../test-fixtures/matches";
import reversi from "../../../test-fixtures/matches/reversi-standard-draw.json";
import gomokuOn from "../../../test-fixtures/matches/gomoku-on-five.json";
import gomokuOff from "../../../test-fixtures/matches/gomoku-off-overline.json";
import ranked from "../../../test-fixtures/matches/four-gomoku-singles-ranked.json";
import full from "../../../test-fixtures/matches/four-gomoku-singles-full.json";
import mixed from "../../../test-fixtures/matches/four-gomoku-doubles-mixed.json";
import eliminated from "../../../test-fixtures/matches/four-gomoku-doubles-elimination.json";
import { accountFixture } from "./accountFixtures";
import { boundaryRequest } from "./roomBoundaryFixtures";
import { readStoredMatch, matchDataContracts } from "../src/accounts/matchDataContracts";
import { readMatchDetailRecord } from "../src/rooms/snapshotMatchStore";
import { writeMatch } from "../src/rooms/matchStore";
import type { SnapshotMatch } from "../src/rooms/snapshotMatchEvents";

function recordJson(detail: typeof reversi.detail | typeof gomokuOn.detail) {
  return JSON.stringify({
    ...detail,
    instanceId: crypto.randomUUID(),
    participants: detail.participants.map(({ avatarUrl: _avatar, ...player }) => ({
      ...player,
      accountId: player.seat === 0 ? "fixture-self" : null,
    })),
  });
}
const fixtures = [
  ...reversiArchives.map(({ name, recordJson: json }) => ({ name, json })),
  { name: "reversi", json: recordJson(reversi.detail) },
  { name: "gomoku-on", json: recordJson(gomokuOn.detail) },
  { name: "gomoku-off", json: recordJson(gomokuOff.detail) },
  ...[ranked, full, mixed, eliminated].map(({ name, recordJson: json }) => ({ name, json })),
];
const ids = new Set<string>();
afterEach(async () => {
  for (const id of ids) await remove(id);
  ids.clear();
});
async function remove(id: string) {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM account_match_history WHERE match_id = ?").bind(id),
    env.APP_DB.prepare("DELETE FROM match_event_chunks WHERE match_id = ?").bind(id),
    env.APP_DB.prepare("DELETE FROM match_uploads WHERE id = ?").bind(id),
    env.APP_DB.prepare("DELETE FROM matches WHERE id = ?").bind(id),
  ]);
}
function readLegacy(json: string): SnapshotMatch {
  const match = readStoredMatch(json, JSON.parse(json).settings.game);
  switch (match.game) {
    case "reversi":
      return matchDataContracts.reversi.read(json);
    case "four-reversi":
      return matchDataContracts["four-reversi"].read(json);
    case "gomoku":
      return matchDataContracts.gomoku.read(json);
    case "four-gomoku":
      return matchDataContracts["four-gomoku"].read(json);
    default:
      throw Error("Not a snapshot game");
  }
}
async function responses(record: SnapshotMatch, cookie: string) {
  const publicResponse = await boundaryRequest(`/matches/${record.id}`);
  const ownResponse = await boundaryRequest(`/account/matches/${record.id}`, {
    headers: { Cookie: cookie },
  });
  expect(publicResponse.status).toBe(200);
  expect(ownResponse.status).toBe(200);
  return { public: await publicResponse.json(), own: await ownResponse.json() };
}
for (const fixture of fixtures)
  test(`${fixture.name}: 新旧保存の公開・本人詳細で全ステップと最終結果が一致する`, async () => {
    const user = await accountFixture();
    const record = readLegacy(fixture.json.replaceAll("fixture-self", user.id));
    ids.add(record.id);
    await remove(record.id);
    await env.APP_DB.batch([
      env.APP_DB.prepare("INSERT INTO matches VALUES (?, ?, ?, ?, ?, ?)").bind(
        record.id,
        record.settings.game,
        "mode" in record.settings ? record.settings.mode : "standard",
        record.startedAtMs,
        record.endedAtMs,
        JSON.stringify(record),
      ),
      env.APP_DB.prepare("INSERT INTO account_match_history VALUES (?, ?, ?, ?, ?)").bind(
        user.id,
        record.id,
        "mode" in record.settings ? record.settings.mode : "standard",
        record.startedAtMs,
        record.settings.game,
      ),
    ]);
    const expected = await responses(record, user.cookie);
    await remove(record.id);
    await writeMatch(env.APP_DB, record);
    expect(await responses(record, user.cookie)).toEqual(expected);
    const raw = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
      .bind(record.id)
      .first<{ record_json: string }>();
    const stored = JSON.parse(raw!.record_json);
    expect(stored.replay).toMatchObject({
      format: "events",
      version: 1,
      eventCount: record.replay.steps.length,
    });
    expect(stored.replay).not.toHaveProperty("steps");
    expect(
      await env.APP_DB.prepare("SELECT id FROM match_uploads WHERE id = ?").bind(record.id).first(),
    ).toBeNull();
    const queries: string[] = [];
    const db = new Proxy(env.APP_DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            queries.push(sql);
            return target.prepare(sql);
          };
        return Reflect.get(target, key);
      },
    });
    const decoded = await readMatchDetailRecord(db, raw!.record_json, record.settings.game);
    expect(decoded.record).toEqual(record);
    expect(queries.filter((sql) => sql.includes("match_event_chunks"))).toHaveLength(1);
    const history = await boundaryRequest(
      `/account/matches?game=${record.settings.game}${"mode" in record.settings ? `&mode=${record.settings.mode}` : ""}`,
      { headers: { Cookie: user.cookie } },
    );
    expect(history.status).toBe(200);
  });

test("大きな棋譜を100イベントのチャンクへ分け、再送・途中失敗・競合を安全に扱う", async () => {
  const user = await accountFixture();
  const record = readLegacy(full.recordJson.replaceAll("fixture-self", user.id));
  ids.add(record.id);
  await remove(record.id);
  expect(new TextEncoder().encode(JSON.stringify(record)).length).toBeGreaterThan(100_000);
  await env.APP_DB.prepare(`CREATE TRIGGER reject_event_publication BEFORE INSERT ON matches
    BEGIN SELECT RAISE(ABORT, 'publication unavailable'); END`).run();
  try {
    await expect(writeMatch(env.APP_DB, record)).rejects.toThrow();
    expect(
      await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?").bind(record.id).first(),
    ).toBeNull();
    expect(
      await env.APP_DB.prepare("SELECT chunk_count FROM match_uploads WHERE id = ?")
        .bind(record.id)
        .first(),
    ).toEqual({ chunk_count: 3 });
  } finally {
    await env.APP_DB.exec("DROP TRIGGER reject_event_publication");
  }
  const chunks = await env.APP_DB.prepare(
    "SELECT event_count, events_json FROM match_event_chunks WHERE match_id = ? ORDER BY chunk_index",
  )
    .bind(record.id)
    .all<{ event_count: number; events_json: string }>();
  expect(chunks.results.map((row) => row.event_count)).toEqual([100, 100, 25]);
  expect(chunks.results.every((row) => row.events_json.length < 100_000)).toBe(true);
  await env.APP_DB.prepare(
    "UPDATE match_event_chunks SET events_json = '[]' WHERE match_id = ? AND chunk_index = 1",
  )
    .bind(record.id)
    .run();
  await expect(writeMatch(env.APP_DB, record)).rejects.toThrow();
  await env.APP_DB.prepare(
    "UPDATE match_event_chunks SET events_json = ? WHERE match_id = ? AND chunk_index = 1",
  )
    .bind(chunks.results[1].events_json, record.id)
    .run();
  await env.APP_DB.prepare("INSERT INTO match_event_chunks VALUES (?, 3, 300, 1, '[]')")
    .bind(record.id)
    .run();
  await expect(writeMatch(env.APP_DB, record)).rejects.toThrow("Match publication was incomplete");
  expect(
    await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?").bind(record.id).first(),
  ).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT id FROM match_uploads WHERE id = ?").bind(record.id).first(),
  ).not.toBeNull();
  await env.APP_DB.prepare("DELETE FROM match_event_chunks WHERE match_id = ? AND chunk_index = 3")
    .bind(record.id)
    .run();
  await writeMatch(env.APP_DB, record);
  const saved = await responses(record, user.cookie);
  await writeMatch(env.APP_DB, { ...record, endedAtMs: record.endedAtMs + 1000 });
  expect(await responses(record, user.cookie)).toEqual(saved);
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM account_match_history WHERE match_id = ?")
      .bind(record.id)
      .first(),
  ).toEqual({ n: 1 });
  await env.APP_DB.prepare("DELETE FROM match_event_chunks WHERE match_id = ? AND chunk_index = 1")
    .bind(record.id)
    .run();
  expect((await boundaryRequest(`/matches/${record.id}`)).status).toBe(503);
  expect((await boundaryRequest(`/matches?game=four-gomoku`)).status).toBe(200);
  expect(
    (
      await boundaryRequest(`/account/matches?game=four-gomoku&mode=singles`, {
        headers: { Cookie: user.cookie },
      })
    ).status,
  ).toBe(200);
});

test("イベントの再生と最終局面が異なる対局は公開しない", async () => {
  const record = readLegacy(recordJson(reversi.detail));
  ids.add(record.id);
  await remove(record.id);
  record.game.moveNumber++;
  await expect(writeMatch(env.APP_DB, record)).rejects.toThrow("Match replay final state mismatch");
  expect(
    await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?").bind(record.id).first(),
  ).toBeNull();
});
