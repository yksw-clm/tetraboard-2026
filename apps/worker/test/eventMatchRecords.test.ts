import { participantProfiles } from "../src/accounts/matchProfiles";
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
import {
  readStoredMatch,
  readMatchRecord,
  publicMatchDetail,
  matchDetail,
} from "../src/accounts/matchDataContracts";
import { readMatchDetailRecord } from "../src/rooms/snapshotMatchStore";
import { writeMatch } from "../src/flows/matchSave/snapshot";
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
function readSnapshot(json: string): SnapshotMatch {
  const match = readMatchRecord(json, JSON.parse(json).settings.game);
  if (match.game === "shogi" || match.game === "four-shogi") throw Error("Not a snapshot game");
  return match.record;
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
  test(`${fixture.name}: イベント保存の公開・本人詳細で完全な棋譜の全ステップと最終結果を保持する`, async () => {
    const user = await accountFixture();
    const record = readSnapshot(fixture.json.replaceAll("fixture-self", user.id));
    ids.add(record.id);
    await remove(record.id);
    await writeMatch(env.APP_DB, record);
    const complete = readMatchRecord(JSON.stringify(record), record.settings.game);
    const profiles = await participantProfiles(env.APP_DB, [complete]);
    expect(await responses(record, user.cookie)).toEqual({
      public: { match: publicMatchDetail(complete, profiles) },
      own: {
        match: matchDetail(
          complete,
          record.participants.find((p) => p.kind === "human" && p.accountId === user.id)!.id,
          profiles,
        ),
      },
    });
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
  const record = readSnapshot(full.recordJson.replaceAll("fixture-self", user.id));
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
  const record = readSnapshot(recordJson(reversi.detail));
  ids.add(record.id);
  await remove(record.id);
  record.game.moveNumber++;
  await expect(writeMatch(env.APP_DB, record)).rejects.toThrow("Match replay final state mismatch");
  expect(
    await env.APP_DB.prepare("SELECT id FROM matches WHERE id = ?").bind(record.id).first(),
  ).toBeNull();
});

for (const fixture of fixtures) {
  test(`${fixture.name}: stepsを持つ古いD1本体を拒否し、既存の取得失敗として扱う`, async () => {
    const user = await accountFixture();
    const record = readSnapshot(fixture.json.replaceAll("fixture-self", user.id));
    record.startedAtMs = Date.UTC(2099, 0, 1);
    record.endedAtMs = record.startedAtMs + 1000;
    ids.add(record.id);
    await remove(record.id);
    expect(() => readStoredMatch(JSON.stringify(record), record.settings.game)).toThrow();
    await env.APP_DB.prepare("INSERT INTO matches VALUES (?, ?, ?, ?, ?, ?)")
      .bind(
        record.id,
        record.settings.game,
        "mode" in record.settings ? record.settings.mode : "standard",
        record.startedAtMs,
        record.endedAtMs,
        JSON.stringify(record),
      )
      .run();
    await env.APP_DB.prepare("INSERT INTO account_match_history VALUES (?, ?, ?, ?, ?)")
      .bind(
        user.id,
        record.id,
        "mode" in record.settings ? record.settings.mode : "standard",
        record.startedAtMs,
        record.settings.game,
      )
      .run();
    for (const path of [
      `/matches/${record.id}`,
      `/account/matches/${record.id}`,
      `/matches?game=${record.settings.game}`,
      `/account/matches?game=${record.settings.game}${"mode" in record.settings ? `&mode=${record.settings.mode}` : ""}`,
    ]) {
      const response = await boundaryRequest(path, { headers: { Cookie: user.cookie } });
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
}
