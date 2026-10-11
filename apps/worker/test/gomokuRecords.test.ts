import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import {
  publicGomokuMatchDetailSchema,
  gomokuReplaySchema,
  gomokuAccountStatsSchema,
  reversiRankingsSchema,
  getPlayerProfileContract,
  gomokuMatchSummarySchema,
} from "@tetraboard/protocol";
import { createInitialState, eliminateColor, applyAction } from "@tetraboard/gomoku";
import archive from "../../../test-fixtures/matches/gomoku-on-five.json";
import { writeMatch } from "../src/rooms/matchStore";
import type { MatchRecord } from "../src/rooms/gomokuMatchStore";
import { readStoredMatch, publicMatchDetail } from "../src/accounts/matchDataContracts";
import { accountFixture } from "./accountFixtures";
import { boundaryRequest } from "./roomBoundaryFixtures";
import { humanFixtureRecord } from "./matchFixtures";
beforeEach(async () => {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM account_match_history"),
    env.APP_DB.prepare("DELETE FROM matches"),
  ]);
});
function record(accountId: string, outcome: "win" | "loss" | "draw", cpu = false): MatchRecord {
  const detail = publicGomokuMatchDetailSchema.parse(archive.detail);
  const id = crypto.randomUUID();
  const forbiddenRules = outcome !== "draw";
  let state = createInitialState(forbiddenRules);
  const initial = state;
  const steps: {
    action:
      | { type: "place"; color: "black" | "white"; position: { x: number; y: number } }
      | { type: "eliminate"; color: "black" | "white"; reason: "left" };
    game: typeof state;
  }[] = [];
  if (outcome === "draw") {
    const black: { x: number; y: number }[] = [],
      white: { x: number; y: number }[] = [];
    for (let y = 0; y < 15; y++)
      for (let x = 0; x < 15; x++) ((x + 2 * y) % 4 < 2 ? black : white).push({ x, y });
    for (let i = 0; i < 225; i++) {
      const color = i % 2 === 0 ? "black" : "white";
      const position = (color === "black" ? black : white).shift()!;
      const result = applyAction(state, { type: "placeStone", position });
      if (!result.ok) throw Error("invalid draw");
      state = result.state;
      steps.push({ action: { type: "place", color, position }, game: state });
    }
  } else {
    const color = outcome === "win" ? "white" : "black";
    const result = eliminateColor(state, color);
    if (!result.ok) throw Error("invalid defeat");
    state = result.state;
    steps.push({ action: { type: "eliminate", color, reason: "left" }, game: state });
  }
  const game = state;
  if (game.status !== "finished") throw Error("Not finished");
  return {
    id,
    roomId: detail.roomId,
    instanceId: crypto.randomUUID(),
    startedAtMs: detail.startedAtMs,
    endedAtMs: detail.endedAtMs,
    settings: { ...detail.settings, forbiddenRules },
    participants: detail.participants.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      seat: p.seat,
      ...(cpu && p.color === "white"
        ? { kind: "cpu" as const, level: 1 as const }
        : { kind: "human" as const, accountId: p.color === "black" ? accountId : null }),
    })),
    game,
    eliminations:
      outcome === "draw" ? [] : [{ color: outcome === "win" ? "white" : "black", reason: "left" }],
    replay: gomokuReplaySchema.parse({ id, initial, steps }),
  };
}
async function stats(cookie: string) {
  const response = await boundaryRequest("/account/stats?game=gomoku", {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return gomokuAccountStatsSchema.parse(await response.json());
}
test("禁手ON/OFFの勝敗・引き分けを合算し、再保存で重複しない", async () => {
  const user = await accountFixture();
  const records = ["win", "loss", "draw"].map((outcome) =>
    record(user.id, outcome as "win" | "loss" | "draw"),
  );
  for (const item of records) {
    await writeMatch(env.APP_DB, item);
    await writeMatch(env.APP_DB, item);
  }
  await writeMatch(env.APP_DB, humanFixtureRecord(user.id, 1000, "singles"));
  expect(await stats(user.cookie)).toEqual({ total: 3, wins: 1, losses: 1, draws: 1 });
  const history = await boundaryRequest("/account/matches?game=gomoku", {
    headers: { Cookie: user.cookie },
  });
  expect(history.status).toBe(200);
  const page = (await history.json()) as { matches: unknown[] };
  expect(page.matches).toHaveLength(3);
  for (const item of page.matches) {
    const match = gomokuMatchSummarySchema.parse(item);
    expect(match).not.toHaveProperty("mode");
  }
  const ranking = await boundaryRequest("/games/gomoku/rankings");
  expect(ranking.status).toBe(200);
  const ranks = reversiRankingsSchema.parse(await ranking.json());
  expect(ranks.wins.find((p) => p.username === user.username)?.value).toBe(1);
  expect(ranks.total.find((p) => p.username === user.username)?.value).toBe(3);
  for (const path of [
    "/account/matches?game=gomoku&mode=singles",
    "/account/matches?game=gomoku&mode=doubles",
  ])
    expect((await boundaryRequest(path, { headers: { Cookie: user.cookie } })).status).toBe(400);
});
test("CPU戦のみの登録者は戦績0、履歴・公開棋譜は保持し、対人絞り込みから除く", async () => {
  const user = await accountFixture();
  const item = record(user.id, "win", true);
  await writeMatch(env.APP_DB, item);
  expect(await stats(user.cookie)).toEqual({ total: 0, wins: 0, losses: 0, draws: 0 });
  expect(
    (await boundaryRequest(`/account/matches/${item.id}`, { headers: { Cookie: user.cookie } }))
      .status,
  ).toBe(200);
  expect((await boundaryRequest(`/matches/${item.id}`)).status).toBe(200);
  const all = await boundaryRequest("/matches?game=gomoku");
  expect(JSON.stringify(await all.json())).toContain(item.id);
  const human = await boundaryRequest("/matches?game=gomoku&humanOnly=true");
  expect(JSON.stringify(await human.json())).not.toContain(item.id);
  const response = await boundaryRequest("/games/gomoku/rankings");
  const ranks = reversiRankingsSchema.parse(await response.json());
  expect(ranks.total.find((p) => p.username === user.username)).toBeUndefined();
});
test("固定棋譜は保存契約・公開契約を通り、ゲーム取り違えと破損記録を拒否する", async () => {
  const user = await accountFixture();
  const item = record(user.id, "draw");
  const json = JSON.stringify(item);
  const decoded = readStoredMatch(json, "gomoku");
  expect(decoded.game).toBe("gomoku");
  const detail = publicGomokuMatchDetailSchema.parse(publicMatchDetail(decoded, new Map()));
  expect(detail.game.result).toEqual({
    reason: "board_full",
    winner: null,
    stoneCounts: { black: 113, white: 112 },
    winningLines: [],
  });
  expect(detail.game.moveNumber).toBe(225);
  expect(JSON.stringify(detail)).not.toContain(user.id);
  expect(JSON.stringify(detail)).not.toContain("accountId");
  expect(JSON.stringify(detail)).not.toContain("instanceId");
  expect(() => readStoredMatch(json, "four-gomoku")).toThrow();
  expect(() =>
    readStoredMatch(
      JSON.stringify({ ...item, participants: item.participants.slice(0, 1) }),
      "gomoku",
    ),
  ).toThrow();
});
test("ユーザー情報カードは五目並べの戦績を返し、バッジを付与しない", async () => {
  const user = await accountFixture();
  const item = record(user.id, "win");
  await writeMatch(env.APP_DB, item);
  const query = new URLSearchParams({
    game: "gomoku",
    source: "match",
    matchId: item.id,
    playerId: item.participants[0].id,
    includeBadges: "1",
  });
  const response = await boundaryRequest(`/player-profile?${query}`);
  expect(response.status).toBe(200);
  const profile = getPlayerProfileContract.response.parse(await response.json());
  if (profile.kind !== "account") throw Error("Not account");
  expect(profile.stats).toEqual({ total: 1, wins: 1, losses: 0, draws: 0 });
  expect(profile.badges ?? []).toEqual([]);
});
test("本人以外の棋譜を拒否し、戦績の取得失敗をゼロ件にしない", async () => {
  const user = await accountFixture();
  const other = await accountFixture();
  const item = record(user.id, "draw");
  await writeMatch(env.APP_DB, item);
  expect((await boundaryRequest("/account/stats?game=gomoku")).status).toBe(401);
  expect(
    (await boundaryRequest(`/account/matches/${item.id}`, { headers: { Cookie: other.cookie } }))
      .status,
  ).toBe(404);
  await env.APP_DB.exec("ALTER TABLE matches RENAME TO gomoku_matches_unavailable");
  try {
    expect(
      (await boundaryRequest("/account/stats?game=gomoku", { headers: { Cookie: user.cookie } }))
        .status,
    ).toBe(503);
    expect((await boundaryRequest("/games/gomoku/rankings")).status).toBe(503);
  } finally {
    await env.APP_DB.exec("ALTER TABLE gomoku_matches_unavailable RENAME TO matches");
  }
});
