import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import {
  publicReversiMatchDetailSchema,
  reversiReplaySchema,
  reversiAccountStatsSchema,
  reversiRankingsSchema,
  getPlayerProfileContract,
  reversiMatchSummarySchema,
} from "@tetraboard/protocol";
import { createInitialState, eliminateColor } from "@tetraboard/reversi";
import archive from "../../../test-fixtures/matches/reversi-standard-draw.json";
import { writeMatch } from "../src/rooms/matchStore";
import type { MatchRecord } from "../src/rooms/reversiMatchStore";
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
  const detail = publicReversiMatchDetailSchema.parse(archive.detail);
  const id = crypto.randomUUID();
  const result =
    outcome === "draw"
      ? null
      : eliminateColor(createInitialState(), outcome === "win" ? "white" : "black");
  if (result && !result.ok) throw Error("Could not finish fixture");
  const game = result?.ok ? result.state : detail.game;
  if (game.status !== "finished") throw Error("Not finished");
  return {
    id,
    roomId: detail.roomId,
    instanceId: crypto.randomUUID(),
    startedAtMs: detail.startedAtMs,
    endedAtMs: detail.endedAtMs,
    settings: detail.settings,
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
    replay: reversiReplaySchema.parse(
      outcome === "draw"
        ? { ...detail.replay, id }
        : {
            id,
            initial: createInitialState(),
            steps: [
              {
                action: {
                  type: "eliminate",
                  color: outcome === "win" ? "white" : "black",
                  reason: "left",
                },
                game,
                passedColors: [],
              },
            ],
          },
    ),
  };
}
async function stats(cookie: string) {
  const response = await boundaryRequest("/account/stats?game=reversi", {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return reversiAccountStatsSchema.parse(await response.json());
}
test("勝ち・負け・引き分けをモードなしで集計し、再保存で重複しない", async () => {
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
  const history = await boundaryRequest("/account/matches?game=reversi", {
    headers: { Cookie: user.cookie },
  });
  expect(history.status).toBe(200);
  const page = (await history.json()) as { matches: unknown[] };
  expect(page.matches).toHaveLength(3);
  for (const item of page.matches) {
    const match = reversiMatchSummarySchema.parse(item);
    expect(match).not.toHaveProperty("mode");
  }
  const ranking = await boundaryRequest("/games/reversi/rankings");
  expect(ranking.status).toBe(200);
  const ranks = reversiRankingsSchema.parse(await ranking.json());
  expect(ranks.wins.find((p) => p.username === user.username)?.value).toBe(1);
  expect(ranks.total.find((p) => p.username === user.username)?.value).toBe(3);
  for (const path of [
    "/account/matches?game=reversi&mode=singles",
    "/account/matches?game=reversi&mode=doubles",
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
  const all = await boundaryRequest("/matches?game=reversi");
  expect(JSON.stringify(await all.json())).toContain(item.id);
  const human = await boundaryRequest("/matches?game=reversi&humanOnly=true");
  expect(JSON.stringify(await human.json())).not.toContain(item.id);
  const response = await boundaryRequest("/games/reversi/rankings");
  const ranks = reversiRankingsSchema.parse(await response.json());
  expect(ranks.total.find((p) => p.username === user.username)).toBeUndefined();
});
test("固定棋譜は保存契約・公開契約を通り、ゲーム取り違えと破損記録を拒否する", async () => {
  const user = await accountFixture();
  const item = record(user.id, "draw");
  const json = JSON.stringify(item);
  const decoded = readStoredMatch(json, "reversi");
  expect(decoded.game).toBe("reversi");
  const detail = publicReversiMatchDetailSchema.parse(publicMatchDetail(decoded, new Map()));
  expect(detail.game.result).toEqual({
    reason: "board_full",
    winner: null,
    stoneCounts: archive.expected.stoneCounts,
  });
  expect(detail.game.moveNumber).toBe(archive.expected.moveNumber);
  expect(JSON.stringify(detail)).not.toContain(user.id);
  expect(JSON.stringify(detail)).not.toContain("accountId");
  expect(JSON.stringify(detail)).not.toContain("instanceId");
  expect(() => readStoredMatch(json, "four-reversi")).toThrow();
  expect(() =>
    readStoredMatch(
      JSON.stringify({ ...item, participants: item.participants.slice(0, 1) }),
      "reversi",
    ),
  ).toThrow();
});
test("ユーザー情報カードは通常リバーシの戦績を返し、バッジを付与しない", async () => {
  const user = await accountFixture();
  const item = record(user.id, "win");
  await writeMatch(env.APP_DB, item);
  const query = new URLSearchParams({
    game: "reversi",
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
  expect((await boundaryRequest("/account/stats?game=reversi")).status).toBe(401);
  expect(
    (await boundaryRequest(`/account/matches/${item.id}`, { headers: { Cookie: other.cookie } }))
      .status,
  ).toBe(404);
  await env.APP_DB.exec("ALTER TABLE matches RENAME TO reversi_matches_unavailable");
  try {
    expect(
      (await boundaryRequest("/account/stats?game=reversi", { headers: { Cookie: user.cookie } }))
        .status,
    ).toBe(503);
    expect((await boundaryRequest("/games/reversi/rankings")).status).toBe(503);
  } finally {
    await env.APP_DB.exec("ALTER TABLE reversi_matches_unavailable RENAME TO matches");
  }
});
