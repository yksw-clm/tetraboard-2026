import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import worker from "../src/worker";
import { afterEach, beforeAll, expect, test } from "vitest";
import {
  listPublicMatchesContract,
  getPublicMatchContract,
  getPublicMatchReplayContract,
  listMatchesContract,
  getMatchContract,
  getAccountStatsContract,
  type GameId,
  type RoomMode,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { fixtureRecord, humanFixtureRecord } from "./matchFixtures";
import { writeMatch } from "../src/rooms/matchStore";
import { advanceShogiMatchSave } from "../src/rooms/shogiMatchStore";
import { shogiRecord, humanShogiRecord, saveShogiFixture } from "./shogiMatchFixtures";

const db = (env as typeof env & { PUBLIC_MATCH_TEST_DB: D1Database }).PUBLIC_MATCH_TEST_DB;
const createdIds: string[] = [];
// GameRoom alarms keep writing to APP_DB; route these HTTP requests to a separate real D1.
const matchRequest = (path: string, init?: RequestInit) =>
  worker.fetch(
    new Request(`${origin}/api${path}`, init),
    { ...env, APP_DB: db },
    {} as ExecutionContext,
  );
beforeAll(async () => {
  const migrations = (
    env as typeof env & {
      TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
    }
  ).TEST_MIGRATIONS;
  await applyD1Migrations(db, migrations);
});
afterEach(async () => {
  for (const id of createdIds.splice(0)) {
    await db.batch([
      db.prepare("DELETE FROM account_match_history WHERE match_id = ?").bind(id),
      db.prepare("DELETE FROM matches WHERE id = ?").bind(id),
      db.prepare("DELETE FROM shogi_match_chunks WHERE match_id = ?").bind(id),
      db.prepare("DELETE FROM shogi_match_uploads WHERE id = ?").bind(id),
    ]);
  }
});
async function list(game: GameId, humanOnly?: boolean) {
  const filter = humanOnly === undefined ? "" : `&humanOnly=${humanOnly}`;
  const response = await matchRequest(`/matches?game=${game}${filter}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return listPublicMatchesContract.response.parse(await response.json()).matches;
}
function track<T extends { id: string }>(record: T) {
  createdIds.push(record.id);
  return record;
}

async function saveFilteredFixture(
  game: GameId,
  namespace: string,
  index: number,
  mode: RoomMode,
  cpu: boolean,
) {
  if (game === "four-reversi") {
    const record = track(humanFixtureRecord(namespace, index, mode));
    record.participants = record.participants.map((player) =>
      player.kind === "human" ? { ...player, accountId: null } : player,
    );
    if (cpu) {
      const player = record.participants[3];
      if (player.kind !== "human") throw new Error("Expected human fixture");
      const { accountId: _accountId, ...identity } = player;
      record.participants[3] = { ...identity, kind: "cpu", level: 1 };
    }
    record.startedAtMs += cpu ? 500 : index <= 5 ? 100 : 0;
    await writeMatch(db, record);
    return record;
  }
  const fixture = humanShogiRecord(null, "south", mode);
  const record = track(fixture.record);
  if (cpu) {
    const player = record.participants[3];
    if (player.kind !== "human") throw new Error("Expected human fixture");
    const { accountId: _accountId, ...identity } = player;
    record.participants[3] = { ...identity, kind: "cpu", level: 1 };
  }
  record.startedAtMs += cpu ? 500 : index <= 5 ? 100 : 0;
  await saveShogiFixture(fixture, db);
  return record;
}

for (const game of ["four-reversi", "four-shogi"] as const) {
  for (const count of [0, 23]) {
    test(`${game}: 新しいCPU戦21件より前の人間4人の対局${count}件から最新20件を取得する`, async () => {
      const namespace = crypto.randomUUID();
      const records = [];
      for (let i = 1; i <= count; i++) {
        records.push(
          await saveFilteredFixture(game, namespace, i, i % 2 ? "singles" : "doubles", false),
        );
      }
      for (let i = count + 1; i <= count + 21; i++) {
        await saveFilteredFixture(game, namespace, i, i % 2 ? "singles" : "doubles", true);
      }
      const expected = records
        .sort((a, b) => b.startedAtMs - a.startedAtMs || b.id.localeCompare(a.id))
        .slice(0, 20);
      const matches = await list(game, true);
      expect(matches.map((match) => match.id)).toEqual(expected.map((record) => record.id));
      expect(
        matches.every(
          (match) => match.game === game && match.participants.every((p) => p.kind === "human"),
        ),
      ).toBe(true);
      if (count) {
        expect(matches.some((match) => match.mode === "singles")).toBe(true);
        expect(matches.some((match) => match.mode === "doubles")).toBe(true);
      }
      const unfiltered = await list(game);
      expect(unfiltered).toHaveLength(20);
      expect(
        unfiltered.every(
          (match) => match.participants.filter((p) => p.kind === "cpu").length === 1,
        ),
      ).toBe(true);
      expect(await list(game, false)).toEqual(unfiltered);
      const otherGame = game === "four-reversi" ? "four-shogi" : "four-reversi";
      expect(await list(otherGame, true)).toEqual([]);
    });
  }
}

for (const count of [0, 20, 23]) {
  test(`${count}件から開始日時・UUID降順の最新20件だけを匿名取得できる`, async () => {
    const namespace = crypto.randomUUID();
    const records = [];
    for (let i = 1; i <= count; i++) {
      const record = track(fixtureRecord(namespace, i, i % 2 ? "singles" : "doubles"));
      record.startedAtMs += i <= 5 ? 1000 : 0;
      // End time deliberately disagrees with start time ordering.
      record.endedAtMs += i * 1000;
      record.participants = record.participants.map((p) =>
        p.kind === "human" ? { ...p, accountId: null } : p,
      );
      records.push(record);
      await writeMatch(db, record);
    }
    const expected = records
      .sort((a, b) => b.startedAtMs - a.startedAtMs || b.id.localeCompare(a.id))
      .slice(0, 20);
    const matches = await list("four-reversi");
    expect(matches.map((m) => m.id)).toEqual(expected.map((m) => m.id));
    if (count) {
      expect(matches.some((m) => m.mode === "singles")).toBe(true);
      expect(matches.some((m) => m.mode === "doubles")).toBe(true);
      expect(matches[0].participants.some((p) => p.kind === "cpu")).toBe(true);
    }
  });
}

test("ゲーム別に対人・CPU・ゲスト終局を表示し、転送途中の将棋を公開しない", async () => {
  const namespace = crypto.randomUUID();
  const human = track(humanFixtureRecord(namespace, 1));
  await writeMatch(db, human);
  const fixture = shogiRecord(null, "east", "doubles");
  track(fixture.record);
  await saveShogiFixture(fixture, db);
  const pending = shogiRecord(null);
  track(pending.record);
  await advanceShogiMatchSave(db, pending.record, { phase: "upload", cursor: 0 }, (cursor) =>
    pending.events.slice(cursor, cursor + 100),
  );
  expect((await list("four-reversi")).map((m) => m.id)).toEqual([human.id]);
  expect((await list("four-shogi")).map((m) => m.id)).toEqual([fixture.record.id]);
  expect((await matchRequest(`/matches/${pending.record.id}`)).status).toBe(404);
  expect((await matchRequest(`/matches/${pending.record.id}/replay`)).status).toBe(404);
});

async function saveProfileFixture(
  game: GameId,
  userId: string,
  mode: RoomMode,
  humans = false,
  configure?: (
    player: { name: string } & ({ kind: "human"; accountId: string | null } | { kind: "cpu" }),
    index: number,
  ) => void,
) {
  if (game === "four-reversi") {
    const record = track((humans ? humanFixtureRecord : fixtureRecord)(userId, 1, mode));
    if (configure) record.participants.forEach(configure);
    await writeMatch(db, record);
    return record;
  }
  const fixture = (humans ? humanShogiRecord : shogiRecord)(userId, "south", mode);
  track(fixture.record);
  if (configure) fixture.record.participants.forEach(configure);
  await saveShogiFixture(fixture, db);
  return fixture.record;
}
async function profileParticipants(
  game: GameId,
  mode: RoomMode,
  user: Awaited<ReturnType<typeof accountFixture>>,
  id: string,
) {
  const responses = await Promise.all([
    matchRequest(`/matches?game=${game}`),
    matchRequest(`/matches/${id}`),
    matchRequest(`/account/matches?game=${game}&mode=${mode}`, {
      headers: { Cookie: user.cookie },
    }),
    matchRequest(`/account/matches/${id}`, { headers: { Cookie: user.cookie } }),
  ]);
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  const bodies = await Promise.all(responses.map((response) => response.json()));
  const summaries = [
    listPublicMatchesContract.response.parse(bodies[0]).matches.find((match) => match.id === id)!,
    listMatchesContract.response.parse(bodies[2]).matches.find((match) => match.id === id)!,
  ];
  const details = [
    getPublicMatchContract.response.parse(bodies[1]).match,
    getMatchContract.response.parse(bodies[3]).match,
  ];
  expect(getMatchContract.response.parse(bodies[3]).match.selfPlayerId).toBe(
    details[1]!.participants[0]!.id,
  );
  for (const body of bodies) {
    for (const privateValue of [user.id, '"accountId"', '"instanceId"', '"token"', '"chat"'])
      expect(JSON.stringify(body)).not.toContain(privateValue);
  }
  for (const body of bodies.slice(0, 2))
    expect(JSON.stringify(body)).not.toContain('"selfPlayerId"');
  return [...summaries, ...details].map((match) => match.participants);
}
async function storedProfileFixture(id: string) {
  const rows = await db.batch([
    db.prepare("SELECT * FROM matches WHERE id = ?").bind(id),
    db
      .prepare("SELECT * FROM account_match_history WHERE match_id = ? ORDER BY account_id")
      .bind(id),
    db.prepare("SELECT * FROM shogi_match_chunks WHERE match_id = ? ORDER BY chunk_index").bind(id),
  ]);
  return rows.map((row) => row.results);
}
for (const game of ["four-reversi", "four-shogi"] as const) {
  for (const mode of ["singles", "doubles"] as const) {
    test(`${game}/${mode}: 本人用・公開用の一覧と詳細に現在の名前・画像を反映し、保存記録を維持する`, async () => {
      const user = await accountFixture(true, crypto.randomUUID(), db);
      const record = await saveProfileFixture(game, user.id, mode);
      const stored = await storedProfileFixture(record.id);
      const expected = record.participants.map((player) => {
        if (player.kind === "cpu") return player;
        const { accountId: _accountId, ...identity } = player;
        return {
          ...identity,
          name: player.accountId === user.id ? "変更後" : player.name,
          avatarUrl: null as string | null,
        };
      });
      const key = `avatars/${crypto.randomUUID()}.webp`;
      await db
        .prepare("UPDATE user SET name = ?, avatarKey = ? WHERE id = ?")
        .bind("変更後", key, user.id)
        .run();
      for (const player of expected)
        if (player.kind === "human" && player.id === record.participants[0]!.id)
          player.avatarUrl = `/api/avatars/${key.slice(8, -5)}`;
      for (const participants of await profileParticipants(game, mode, user, record.id))
        expect(participants).toEqual(expected);
      await db
        .prepare("UPDATE user SET name = ?, avatarKey = NULL WHERE id = ?")
        .bind("再変更後", user.id)
        .run();
      for (const player of expected) {
        if (player.kind === "human" && player.id === record.participants[0]!.id) {
          player.name = "再変更後";
          player.avatarUrl = null;
        }
      }
      for (const participants of await profileParticipants(game, mode, user, record.id))
        expect(participants).toEqual(expected);
      expect(await storedProfileFixture(record.id)).toEqual(stored);
      expect((await matchRequest(`/account/matches/${record.id}`)).status).toBe(401);
      const other = await accountFixture(true, crypto.randomUUID(), db);
      expect(
        (await matchRequest(`/account/matches/${record.id}`, { headers: { Cookie: other.cookie } }))
          .status,
      ).toBe(404);
    });
  }
  test(`${game}: 同名参加者はアカウントで識別し、ゲスト・参照先なしは保存名を使い戦績を維持する`, async () => {
    const user = await accountFixture(true, crypto.randomUUID(), db);
    const other = await accountFixture(true, crypto.randomUUID(), db);
    const record = await saveProfileFixture(game, user.id, "singles", true, (player, index) => {
      if (player.kind !== "human") throw new Error("Expected human fixture");
      player.name = index < 2 ? "同じ名前" : index === 2 ? "ゲストの名前" : "不在の名前";
      player.accountId = [user.id, other.id, null, crypto.randomUUID()][index]!;
    });
    const before = await storedProfileFixture(record.id);
    const readStats = async () => {
      const response = await matchRequest(`/account/stats?game=${game}`, {
        headers: { Cookie: user.cookie },
      });
      expect(response.status).toBe(200);
      return parseLegacyStats(await response.json());
    };
    const stats = await readStats();
    expect(stats.singles.total).toBe(1);
    const key = `avatars/${crypto.randomUUID()}.webp`;
    await db
      .prepare("UPDATE user SET name = ?, username = ?, avatarKey = ? WHERE id = ?")
      .bind("現在の本人", `new_${user.id.replaceAll("-", "").slice(0, 12)}`, key, user.id)
      .run();
    await db.prepare("UPDATE user SET name = ? WHERE id = ?").bind("現在の相手", other.id).run();
    for (const participants of await profileParticipants(game, "singles", user, record.id)) {
      expect(participants.map((player) => player.name)).toEqual([
        "現在の本人",
        "現在の相手",
        "ゲストの名前",
        "不在の名前",
      ]);
      expect(
        participants.map((player) => (player.kind === "human" ? player.avatarUrl : undefined)),
      ).toEqual([`/api/avatars/${key.slice(8, -5)}`, null, null, null]);
    }
    expect(await storedProfileFixture(record.id)).toEqual(before);
    expect(await readStats()).toEqual(stats);
  });
  test(`${game}: プロフィール取得のDB障害を保存名へのフォールバックで隠さない`, async () => {
    const user = await accountFixture(true, crypto.randomUUID(), db);
    const record = await saveProfileFixture(game, user.id, "singles");
    await db.exec("ALTER TABLE user RENAME COLUMN avatarKey TO avatarKey_unavailable");
    try {
      for (const path of [`/matches?game=${game}`, `/matches/${record.id}`]) {
        const response = await matchRequest(path);
        expect(response.status).toBe(503);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
    } finally {
      await db.exec("ALTER TABLE user RENAME COLUMN avatarKey_unavailable TO avatarKey");
    }
  });
}

for (const mode of ["singles", "doubles"] as const) {
  test(`${mode}の将棋詳細・連番イベントを匿名取得できる`, async () => {
    const fixture = shogiRecord(null, "north", mode);
    track(fixture.record);
    await saveShogiFixture(fixture, db);
    const response = await matchRequest(`/matches/${fixture.record.id}`);
    expect(response.status).toBe(200);
    const match = getPublicMatchContract.response.parse(await response.json()).match;
    expect(match.settings.game).toBe("four-shogi");
    expect(match).not.toHaveProperty("selfPlayerId");
    const replay = await matchRequest(`/matches/${fixture.record.id}/replay`);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Cache-Control")).toBe("no-store");
    const page = getPublicMatchReplayContract.response.parse(await replay.json());
    expect(page.events).toEqual(fixture.events.map((event, index) => ({ index, event })));
    expect(page.nextCursor).toBeNull();
    const end = await matchRequest(
      `/matches/${fixture.record.id}/replay?cursor=${page.eventCount}`,
    );
    expect(getPublicMatchReplayContract.response.parse(await end.json()).events).toEqual([]);
    expect(
      (await matchRequest(`/matches/${fixture.record.id}/replay?cursor=${page.eventCount + 1}`))
        .status,
    ).toBe(400);
  });
}

test("不正条件・未知ID・D1障害・不整合な保存記録を区別する", async () => {
  for (const path of [
    "/matches",
    "/matches?game=",
    "/matches?game=all",
    "/matches?game=four-reversi&humanOnly=",
    "/matches?game=four-reversi&humanOnly=1",
    "/matches?game=four-shogi&humanOnly=TRUE",
    "/matches/bad",
    "/matches/bad/replay",
    `/matches/${crypto.randomUUID()}/replay?cursor=bad`,
  ]) {
    const response = await matchRequest(path);
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect((await matchRequest(`/matches/${crypto.randomUUID()}`)).status).toBe(404);
  const record = track(fixtureRecord(crypto.randomUUID(), 1));
  await writeMatch(db, record);
  expect((await matchRequest(`/matches/${record.id}/replay`)).status).toBe(404);
  await db.prepare("UPDATE matches SET record_json = '{}' WHERE id = ?").bind(record.id).run();
  expect((await matchRequest(`/matches/${record.id}`)).status).toBe(503);
  expect((await matchRequest("/matches?game=four-reversi")).status).toBe(503);
  await db.exec("ALTER TABLE matches RENAME TO matches_unavailable");
  try {
    for (const path of [
      "/matches?game=four-reversi",
      `/matches/${record.id}`,
      `/matches/${record.id}/replay`,
    ]) {
      const response = await matchRequest(path);
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  } finally {
    await db.exec("ALTER TABLE matches_unavailable RENAME TO matches");
  }
});

test("他テストの遅延保存は公開APIの検証DBへ混入しない", async () => {
  const unrelated = fixtureRecord(crypto.randomUUID(), 1);
  try {
    // Models a previous GameRoom alarm saving to its original APP_DB after the public-test setup.
    await writeMatch(env.APP_DB, unrelated);
    expect(await list("four-reversi")).toEqual([]);
  } finally {
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM account_match_history WHERE match_id = ?").bind(unrelated.id),
      env.APP_DB.prepare("DELETE FROM matches WHERE id = ?").bind(unrelated.id),
    ]);
  }
});

function parseLegacyStats(value: unknown) {
  const stats = getAccountStatsContract.response.parse(value);
  if (!("singles" in stats)) throw Error("Expected four-player stats");
  return stats;
}
