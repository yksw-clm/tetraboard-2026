import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import {
  fourGomokuAccountStatsSchema,
  fourReversiRankingsSchema,
  publicFourGomokuMatchDetailSchema,
  getPlayerProfileContract,
} from "@tetraboard/protocol";
import ranked from "../../../test-fixtures/matches/four-gomoku-singles-ranked.json";
import full from "../../../test-fixtures/matches/four-gomoku-singles-full.json";
import mixed from "../../../test-fixtures/matches/four-gomoku-doubles-mixed.json";
import eliminated from "../../../test-fixtures/matches/four-gomoku-doubles-elimination.json";
import { writeMatch } from "../src/rooms/matchStore";
import { fourGomokuMatchData } from "../src/accounts/fourGomokuMatchData";
import { readStoredMatch, publicMatchDetail } from "../src/accounts/matchDataContracts";
import { accountFixture } from "./accountFixtures";
import { boundaryRequest } from "./roomBoundaryFixtures";
beforeEach(async () => {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM account_match_history"),
    env.APP_DB.prepare("DELETE FROM matches"),
  ]);
});
const archives = [ranked, full, mixed, eliminated];
for (const fixture of archives)
  test(`${fixture.name}: 固定棋譜の復元と保存・公開契約`, () => {
    const record = fourGomokuMatchData.read(fixture.recordJson);
    const decoded = readStoredMatch(fixture.recordJson, "four-gomoku");
    const detail = publicFourGomokuMatchDetailSchema.parse(publicMatchDetail(decoded, new Map()));
    expect(detail.game).toEqual(record.game);
    expect(JSON.stringify(detail)).not.toContain("accountId");
    expect(JSON.stringify(detail)).not.toContain("instanceId");
    expect(() => readStoredMatch(fixture.recordJson, "gomoku")).toThrow();
    if (fixture === full) expect(record.game.standings.map((s) => s.rank)).toEqual([1, 1, 1, 1]);
  });
test("全人間の順位別・チーム別集計、同率優勝、重複防止、モード別履歴・ランキング", async () => {
  const user = await accountFixture();
  for (const fixture of archives) {
    const record = fourGomokuMatchData.read(fixture.recordJson.replaceAll("fixture-self", user.id));
    await writeMatch(env.APP_DB, record);
    await writeMatch(env.APP_DB, record);
  }
  const response = await boundaryRequest("/account/stats?game=four-gomoku", {
    headers: { Cookie: user.cookie },
  });
  expect(response.status).toBe(200);
  expect(fourGomokuAccountStatsSchema.parse(await response.json())).toEqual({
    singles: { total: 2, first: 2, second: 0, third: 0, fourth: 0 },
    doubles: { total: 2, wins: 1, losses: 1, draws: 0 },
  });
  const ranking = await boundaryRequest("/games/four-gomoku/rankings");
  expect(ranking.status).toBe(200);
  const result = fourReversiRankingsSchema.parse(await ranking.json());
  expect(result.singles.first.find((p) => p.username === user.username)?.value).toBe(2);
  expect(result.doubles.wins.find((p) => p.username === user.username)?.value).toBe(1);
  for (const mode of ["singles", "doubles"]) {
    const history = await boundaryRequest(`/account/matches?game=four-gomoku&mode=${mode}`, {
      headers: { Cookie: user.cookie },
    });
    expect(history.status).toBe(200);
    expect(((await history.json()) as { matches: unknown[] }).matches).toHaveLength(2);
  }
  const query = new URLSearchParams({
    game: "four-gomoku",
    source: "match",
    includeBadges: "1",
    matchId: ranked.detail.id,
    playerId: ranked.detail.selfPlayerId,
  });
  const profile = await boundaryRequest(`/player-profile?${query}`);
  expect(profile.status).toBe(200);
  const parsed = getPlayerProfileContract.response.parse(await profile.json());
  expect(JSON.stringify(parsed)).not.toContain("fixture-self");
  if (parsed.kind !== "account") throw Error("Expected account");
  expect(parsed.badges ?? []).toEqual([]);
});
test("CPU戦は保存・閲覧でき、戦績・ランキング・バッジへ加算しない", async () => {
  const user = await accountFixture();
  const record = fourGomokuMatchData.read(ranked.recordJson.replaceAll("fixture-self", user.id));
  const p = record.participants[3];
  record.participants[3] = {
    id: p.id,
    name: p.name,
    color: p.color,
    seat: p.seat,
    kind: "cpu",
    level: 2,
  };
  await writeMatch(env.APP_DB, record);
  const response = await boundaryRequest("/account/stats?game=four-gomoku", {
    headers: { Cookie: user.cookie },
  });
  const stats = fourGomokuAccountStatsSchema.parse(await response.json());
  expect(stats.singles.total).toBe(0);
  expect((await boundaryRequest(`/matches/${record.id}`)).status).toBe(200);
  expect(
    (await boundaryRequest(`/account/matches/${record.id}`, { headers: { Cookie: user.cookie } }))
      .status,
  ).toBe(200);
  const human = await boundaryRequest("/matches?game=four-gomoku&humanOnly=true");
  expect(JSON.stringify(await human.json())).not.toContain(record.id);
  const ranks = fourReversiRankingsSchema.parse(
    await (await boundaryRequest("/games/four-gomoku/rankings")).json(),
  );
  expect(ranks.singles.total.find((p) => p.username === user.username)).toBeUndefined();
});
test("途中順位・着手色・設定・脱落理由の改変を拒否", () => {
  const record = fourGomokuMatchData.read(ranked.recordJson);
  const wrong = structuredClone(record);
  wrong.replay.steps[16].game.standings[0].rank = 4;
  expect(() => fourGomokuMatchData.read(JSON.stringify(wrong))).toThrow();
  const changed = structuredClone(record);
  changed.settings.mode = "doubles";
  expect(() => fourGomokuMatchData.read(JSON.stringify(changed))).toThrow();
  const turn = structuredClone(record);
  turn.replay.steps[0].action.color = "blue";
  expect(() => fourGomokuMatchData.read(JSON.stringify(turn))).toThrow();
  const reason = fourGomokuMatchData.read(eliminated.recordJson);
  if (reason.replay.steps[0].action.type === "eliminate")
    reason.replay.steps[0].action.reason = "timeout"; // ダブルスでも外部理由は保存上の整合を確認する。
  expect(() => fourGomokuMatchData.read(JSON.stringify(reason))).toThrow();
});
test("2〜4位は敗数へ変換せず、それぞれの順位の件数に加算する", async () => {
  const user = await accountFixture();
  for (const color of ["white", "red", "blue"]) {
    const record = fourGomokuMatchData.read(ranked.recordJson);
    const id = crypto.randomUUID();
    record.id = id;
    record.replay.id = id;
    for (const p of record.participants)
      if (p.kind === "human") p.accountId = p.color === color ? user.id : null;
    await writeMatch(env.APP_DB, record);
  }
  const response = await boundaryRequest("/account/stats?game=four-gomoku", {
    headers: { Cookie: user.cookie },
  });
  expect(fourGomokuAccountStatsSchema.parse(await response.json()).singles).toEqual({
    total: 3,
    first: 0,
    second: 1,
    third: 1,
    fourth: 1,
  });
});
