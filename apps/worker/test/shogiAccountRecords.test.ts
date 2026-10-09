import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { sides } from "@tetraboard/four-shogi";
import {
  getAccountStatsContract,
  getMatchContract,
  getMatchReplayContract,
  getFourShogiRankingsContract,
  listMatchesContract,
  fourShogiAccountStatsSchema,
  isFourShogiMatch,
  fourShogiMatchDetailSchema,
  fourShogiMatchSummarySchema,
} from "@tetraboard/protocol";
import { accountFixture } from "./accountFixtures";
import { fixtureRecord, humanFixtureRecord, matchRequest } from "./matchFixtures";
import { writeMatch } from "../src/rooms/matchStore";
import { advanceShogiMatchSave } from "../src/rooms/shogiMatchStore";
import { shogiRecord, humanShogiRecord, saveShogiFixture } from "./shogiMatchFixtures";

beforeEach(async () => {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM account_match_history"),
    env.APP_DB.prepare("DELETE FROM matches"),
    env.APP_DB.prepare("DELETE FROM shogi_match_uploads"),
    env.APP_DB.prepare("DELETE FROM shogi_match_chunks"),
  ]);
});
const authenticated = (cookie: string) => ({ headers: { Cookie: cookie } });
async function stats(cookie: string, game = "four-shogi") {
  const response = await matchRequest(`/account/stats?game=${game}`, authenticated(cookie));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return parseLegacyStats(await response.json());
}
async function history(cookie: string, game = "four-shogi", mode = "singles", cursor?: string) {
  const query = new URLSearchParams({ game, mode });
  if (cursor) query.set("cursor", cursor);
  const response = await matchRequest(`/account/matches?${query}`, authenticated(cookie));
  expect(response.status).toBe(200);
  return listMatchesContract.response.parse(await response.json());
}
async function rankings() {
  const response = await matchRequest(getFourShogiRankingsContract.path);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return getFourShogiRankingsContract.response.parse(await response.json());
}

test("戦績はゲーム別に全方向・順位・撃破を集計し、ゲストと未公開保存を除外する", async () => {
  const user = await accountFixture(),
    other = await accountFixture();
  for (const [index, side] of sides.entries()) {
    const fixture = humanShogiRecord(user.id, side);
    // Persisted knockout totals are the account aggregation's input; room tests cover attribution.
    fixture.record.knockouts[side] = index % 3;
    await saveShogiFixture(fixture);
  }
  await saveShogiFixture(humanShogiRecord(other.id));
  await saveShogiFixture(humanShogiRecord(null));
  const pending = humanShogiRecord(user.id);
  await advanceShogiMatchSave(
    env.APP_DB,
    pending.record,
    { phase: "upload", cursor: 0 },
    (cursor) => pending.events.slice(cursor, cursor + 100),
  );
  const reversi = humanFixtureRecord(user.id, 1);
  await writeMatch(env.APP_DB, reversi);
  expect(fourShogiAccountStatsSchema.parse(await stats(user.cookie))).toEqual({
    singles: { total: 4, first: 1, second: 1, third: 1, fourth: 1, knockouts: 3, perfectWins: 0 },
    doubles: { total: 0, wins: 0, losses: 0, draws: 0 },
  });
  expect((await stats(user.cookie, "four-reversi")).singles).toEqual({
    total: 1,
    first: 0,
    second: 0,
    third: 0,
    fourth: 1,
  });
  expect((await history(user.cookie)).matches).toHaveLength(4);
  expect((await history(user.cookie, "four-reversi")).matches.map((match) => match.id)).toEqual([
    reversi.id,
  ]);
  const body = await stats(user.cookie);
  for (const privateValue of [user.id, pending.record.instanceId, '"accountId"', '"record_json"'])
    expect(JSON.stringify(body)).not.toContain(privateValue);
});

test("将棋ダブルスの両チームの勝敗・引き分けを集計し、撃破項目を含めない", async () => {
  const user = await accountFixture();
  for (const side of sides) await saveShogiFixture(humanShogiRecord(user.id, side, "doubles"));
  const draw = humanShogiRecord(user.id, "south", "doubles");
  if (draw.record.game.result.mode !== "doubles") throw new Error("Wrong mode");
  draw.record.game.result = { mode: "doubles", reason: "repetition", winner: null };
  await saveShogiFixture(draw);
  const result = await stats(user.cookie);
  expect(result.doubles).toEqual({ total: 5, wins: 2, losses: 2, draws: 1 });
  expect(result.doubles).not.toHaveProperty("knockouts");
  expect((await history(user.cookie, "four-shogi", "doubles")).matches).toHaveLength(5);
});

test("将棋一覧は本人・ゲーム・モードを絞り、同時刻のUUID順で20件ずつ重複なく取得する", async () => {
  const user = await accountFixture();
  const ids: string[] = [];
  for (let index = 0; index < 23; index++) {
    const fixture = shogiRecord(user.id);
    await saveShogiFixture(fixture);
    ids.push(fixture.record.id);
  }
  await saveShogiFixture(shogiRecord(user.id, "south", "doubles"));
  await writeMatch(env.APP_DB, fixtureRecord(user.id, 2));
  const first = await history(user.cookie);
  expect(first.matches).toHaveLength(20);
  expect(first.nextCursor).not.toBeNull();
  const second = await history(user.cookie, "four-shogi", "singles", first.nextCursor!);
  expect(second.matches).toHaveLength(3);
  expect(second.nextCursor).toBeNull();
  expect([...first.matches, ...second.matches].map((match) => match.id)).toEqual(
    ids.sort().reverse(),
  );
  for (const match of first.matches) {
    expect(match.game).toBe("four-shogi");
    expect(JSON.stringify(match)).not.toContain('"board"');
    expect(JSON.stringify(match)).not.toContain('"accountId"');
  }
});

test("保存棋譜は開始時の本人だけが取得でき、現在の名前とアイコンを返し非公開情報を出さない", async () => {
  const user = await accountFixture(),
    other = await accountFixture();
  const fixture = shogiRecord(user.id, "east");
  await saveShogiFixture(fixture);
  const avatar = crypto.randomUUID();
  await env.APP_DB.prepare("UPDATE user SET name = ?, avatarKey = ? WHERE id = ?")
    .bind("変更した名前", `avatars/${avatar}.webp`, user.id)
    .run();
  const response = await matchRequest(
    `/account/matches/${fixture.record.id}`,
    authenticated(user.cookie),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  const { match } = getMatchContract.response.parse(body);
  if (!isFourShogiMatch(match)) throw new Error("Shogi match missing");
  expect(match.selfPlayerId).toBe(fixture.record.replay.initial.players.east);
  expect(match.game).toEqual(fixture.record.game);
  expect(match.participants.find((player) => player.id === match.selfPlayerId)).toMatchObject({
    name: "変更した名前",
    side: "east",
    avatarUrl: `/api/avatars/${avatar}`,
  });
  for (const value of [user.id, fixture.record.instanceId, '"accountId"', '"chat"', '"token"'])
    expect(JSON.stringify(body)).not.toContain(value);
  const replayPath = getMatchReplayContract.pathFor(fixture.record.id);
  const replay = await matchRequest(replayPath, authenticated(user.cookie));
  expect(replay.status).toBe(200);
  expect(getMatchReplayContract.response.parse(await replay.json())).toEqual({
    matchId: fixture.record.id,
    ...fixture.record.replay,
    events: fixture.events.map((event, index) => ({ index, event })),
    nextCursor: null,
  });
  for (const path of [`/account/matches/${fixture.record.id}`, replayPath]) {
    expect((await matchRequest(path)).status).toBe(401);
    const forbidden = await matchRequest(path, authenticated(other.cookie));
    expect(forbidden.status).toBe(404);
    expect(await forbidden.json()).toEqual({ message: "この棋譜は閲覧できません。" });
    expect(
      (
        await matchRequest(
          path.replace(fixture.record.id, crypto.randomUUID()),
          authenticated(user.cookie),
        )
      ).status,
    ).toBe(404);
  }
  for (const cursor of ["bad", "-1", "1.5", "4", "9007199254740992"]) {
    expect(
      (await matchRequest(`${replayPath}?cursor=${cursor}`, authenticated(user.cookie))).status,
    ).toBe(400);
  }
  await env.APP_DB.prepare("DELETE FROM shogi_match_chunks WHERE match_id = ?")
    .bind(fixture.record.id)
    .run();
  expect((await matchRequest(replayPath, authenticated(user.cookie))).status).toBe(503);
});

test("将棋ランキングは同率優勝・対人戦・引き分けを数え、ゲームと未公開局を混在させない", async () => {
  const user = await accountFixture(),
    other = await accountFixture(),
    incomplete = await accountFixture(false);
  await saveShogiFixture(humanShogiRecord(user.id));
  await saveShogiFixture(humanShogiRecord(other.id));
  const tied = humanShogiRecord(user.id);
  if (tied.record.game.result.mode !== "singles") throw new Error("Wrong mode");
  tied.record.game.result = {
    mode: "singles",
    reason: "repetition",
    standings: sides.map((side) => ({ side, rank: 1 })),
  };
  await saveShogiFixture(tied);
  await saveShogiFixture(humanShogiRecord(incomplete.id));
  await saveShogiFixture(humanShogiRecord(null));
  await saveShogiFixture(humanShogiRecord(user.id, "south", "doubles"));
  await saveShogiFixture(humanShogiRecord(user.id, "west", "doubles"));
  const draw = humanShogiRecord(user.id, "south", "doubles");
  draw.record.game.result = { mode: "doubles", reason: "repetition", winner: null };
  await saveShogiFixture(draw);
  await writeMatch(env.APP_DB, humanFixtureRecord(user.id, 3));
  const pending = humanShogiRecord(user.id);
  await advanceShogiMatchSave(
    env.APP_DB,
    pending.record,
    { phase: "upload", cursor: 0 },
    (cursor) => pending.events.slice(cursor, cursor + 100),
  );
  const result = await rankings();
  expect(result.singles.first.map((entry) => [entry.username, entry.value, entry.rank])).toEqual([
    [user.username, 2, 1],
    [other.username, 1, 2],
  ]);
  expect(result.doubles.wins.map((entry) => [entry.username, entry.value])).toEqual([
    [user.username, 1],
  ]);
  expect(result.doubles.total.map((entry) => [entry.username, entry.value])).toEqual([
    [user.username, 3],
  ]);
  expect(JSON.stringify(result)).not.toContain(user.id);
  expect(JSON.stringify(result)).not.toContain(incomplete.id);
  expect(result.singles).not.toHaveProperty("knockouts");
});

test("不正ゲーム指定を拒否し、省略時には従来のリバーシ戦績と一覧を返す", async () => {
  const user = await accountFixture();
  await saveShogiFixture(shogiRecord(user.id));
  for (const path of ["/account/stats?game=unknown", "/account/matches?mode=singles&game=unknown"])
    expect((await matchRequest(path, authenticated(user.cookie))).status).toBe(400);
  const legacy = await matchRequest("/account/stats", authenticated(user.cookie));
  expect(await legacy.json()).toEqual({
    singles: { total: 0, first: 0, second: 0, third: 0, fourth: 0 },
    doubles: { total: 0, wins: 0, losses: 0, draws: 0 },
  });
  const historyResponse = await matchRequest(
    "/account/matches?mode=singles",
    authenticated(user.cookie),
  );
  expect(listMatchesContract.response.parse(await historyResponse.json()).matches).toEqual([]);
});

test("認証基盤のUUIDではない内部アカウントIDも将棋履歴へ紐付けられる", async () => {
  const user = await accountFixture(true, `auth_${crypto.randomUUID().replaceAll("-", "")}`);
  const fixture = humanShogiRecord(user.id);
  await saveShogiFixture(fixture);
  expect((await stats(user.cookie)).singles.total).toBe(1);
  expect((await history(user.cookie)).matches.map((match) => match.id)).toEqual([
    fixture.record.id,
  ]);
  expect(
    (await matchRequest(`/account/matches/${fixture.record.id}`, authenticated(user.cookie)))
      .status,
  ).toBe(200);
});

test("将棋公開契約は結果モード・順位・参加者の欠落や重複を拒否する", async () => {
  const user = await accountFixture();
  const fixture = shogiRecord(user.id);
  await saveShogiFixture(fixture);
  const response = await matchRequest(
    `/account/matches/${fixture.record.id}`,
    authenticated(user.cookie),
  );
  const { match } = getMatchContract.response.parse(await response.json());
  if (!isFourShogiMatch(match)) throw new Error("Wrong game");
  const summary = (await history(user.cookie)).matches[0];
  if (summary.game !== "four-shogi") throw new Error("Wrong game");
  const badResults = [
    { mode: "doubles", reason: "repetition", winner: null },
    { mode: "singles", reason: "last_player", standings: [] },
    {
      mode: "singles",
      reason: "last_player",
      standings: Array.from({ length: 4 }, () => ({ side: "south", rank: 1 })),
    },
  ];
  for (const result of badResults) {
    expect(
      fourShogiMatchDetailSchema.safeParse({ ...match, game: { ...match.game, result } }).success,
    ).toBe(false);
    expect(fourShogiMatchSummarySchema.safeParse({ ...summary, result }).success).toBe(false);
  }
  const participants = [
    summary.participants[0],
    summary.participants[0],
    ...summary.participants.slice(2),
  ];
  expect(fourShogiMatchSummarySchema.safeParse({ ...summary, participants }).success).toBe(false);
  const corrupt = { ...fixture.record, game: { ...fixture.record.game, result: badResults[0] } };
  await env.APP_DB.prepare("UPDATE matches SET record_json = ? WHERE id = ?")
    .bind(JSON.stringify(corrupt), fixture.record.id)
    .run();
  expect(
    (await matchRequest(`/account/matches/${fixture.record.id}`, authenticated(user.cookie)))
      .status,
  ).toBe(503);
  expect(
    (
      await matchRequest(
        "/account/matches?game=four-shogi&mode=singles",
        authenticated(user.cookie),
      )
    ).status,
  ).toBe(503);
});

function parseLegacyStats(value: unknown) {
  const stats = getAccountStatsContract.response.parse(value);
  if (!("singles" in stats)) throw Error("Expected four-player stats");
  return stats;
}
