import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import {
  getPlayerProfileContract,
  publicShogiMatchDetailSchema,
  shogiAccountStatsSchema,
  reversiRankingsSchema,
  shogiMatchSummarySchema,
  shogiMatchReplayPageSchema,
} from "@tetraboard/protocol";
import { advanceShogiMatchSave, readShogiMatchReplayPage } from "../src/rooms/shogiMatchStore";
import { readStoredMatch, publicMatchDetail } from "../src/accounts/matchDataContracts";
import { accountFixture } from "./accountFixtures";
import { boundaryRequest } from "./roomBoundaryFixtures";
import { humanShogiRecord, saveShogiFixture } from "./shogiMatchFixtures";
import { standardShogiRecord, saveStandardShogiFixture } from "./standardShogiFixtures";

beforeEach(async () => {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM account_match_history"),
    env.APP_DB.prepare("DELETE FROM matches"),
  ]);
});
async function stats(cookie: string) {
  const response = await boundaryRequest("/account/stats?game=shogi", {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  return shogiAccountStatsSchema.parse(await response.json());
}
test("通常将棋の勝敗と千日手を対人戦だけ集計し、四人将棋と区別する", async () => {
  const user = await accountFixture();
  for (const outcome of ["win", "loss", "draw"] as const) {
    const fixture = standardShogiRecord(user.id, outcome);
    await saveStandardShogiFixture(fixture);
    await saveStandardShogiFixture(fixture);
  }
  await saveShogiFixture(humanShogiRecord(user.id));
  const cpu = standardShogiRecord(user.id, "win", true);
  await saveStandardShogiFixture(cpu);
  expect(await stats(user.cookie)).toEqual({ total: 3, wins: 1, losses: 1, draws: 1 });
  const history = await boundaryRequest("/account/matches?game=shogi", {
    headers: { Cookie: user.cookie },
  });
  const page = (await history.json()) as { matches: unknown[] };
  expect(page.matches).toHaveLength(4);
  for (const item of page.matches)
    expect(shogiMatchSummarySchema.parse(item)).not.toHaveProperty("mode");
  const ranking = await boundaryRequest("/games/shogi/rankings");
  const ranks = reversiRankingsSchema.parse(await ranking.json());
  expect(ranks.wins.find((p) => p.username === user.username)?.value).toBe(1);
  expect(ranks.total.find((p) => p.username === user.username)?.value).toBe(3);
  const publicDetail = await boundaryRequest(`/matches/${cpu.record.id}`);
  expect(publicDetail.status).toBe(200);
  const detail = publicShogiMatchDetailSchema.parse(
    ((await publicDetail.json()) as { match: unknown }).match,
  );
  expect(detail.game).toEqual(cpu.record.game);
  expect(JSON.stringify(detail)).not.toContain(user.id);
  expect(JSON.stringify(detail)).not.toContain("accountId");
  const human = await boundaryRequest("/matches?game=shogi&humanOnly=true");
  expect(JSON.stringify(await human.json())).not.toContain(cpu.record.id);
  for (const mode of ["singles", "doubles"])
    expect(
      (
        await boundaryRequest(`/account/matches?game=shogi&mode=${mode}`, {
          headers: { Cookie: user.cookie },
        })
      ).status,
    ).toBe(400);
  const query = new URLSearchParams({
    game: "shogi",
    source: "match",
    matchId: cpu.record.id,
    playerId: cpu.record.participants[0].id,
    includeBadges: "1",
  });
  const profile = getPlayerProfileContract.response.parse(
    await (await boundaryRequest(`/player-profile?${query}`)).json(),
  );
  if (profile.kind !== "account") throw Error("Not account");
  expect(profile.stats).toEqual({ total: 3, wins: 1, losses: 1, draws: 1 });
  expect(profile.badges ?? []).toEqual([]);
});
test("通常将棋の棋譜は公開前の破損を検出し、再試行と100件ページ・ゲーム識別を保持する", async () => {
  const user = await accountFixture();
  const fixture = standardShogiRecord(user.id, "win", false, 110);
  const source = (cursor: number) => fixture.events.slice(cursor, cursor + 100);
  const progress = await advanceShogiMatchSave(
    env.APP_DB,
    fixture.record,
    { phase: "upload", cursor: 0 },
    source,
  );
  expect(progress).toEqual({ phase: "verify", cursor: 0 });
  expect((await boundaryRequest(`/matches/${fixture.record.id}`)).status).toBe(404);
  await env.APP_DB.prepare(
    "UPDATE shogi_match_chunks SET events_json = '[]' WHERE match_id = ? AND chunk_index = 0",
  )
    .bind(fixture.record.id)
    .run();
  await expect(
    advanceShogiMatchSave(env.APP_DB, fixture.record, progress!, source),
  ).rejects.toThrow();
  await env.APP_DB.prepare(
    "UPDATE shogi_match_chunks SET events_json = ? WHERE match_id = ? AND chunk_index = 0",
  )
    .bind(JSON.stringify(source(0)), fixture.record.id)
    .run();
  expect(await advanceShogiMatchSave(env.APP_DB, fixture.record, progress!, source)).toBeNull();
  const first = shogiMatchReplayPageSchema.parse(
    await (await boundaryRequest(`/matches/${fixture.record.id}/replay`)).json(),
  );
  expect(first.events).toHaveLength(100);
  expect(first.nextCursor).toBe(100);
  const overlap = await readShogiMatchReplayPage(env.APP_DB, fixture.record.id, 99, "shogi");
  expect(overlap!.events.map((e) => e.index)).toEqual(Array.from({ length: 12 }, (_, i) => i + 99));
  expect(overlap!.events.at(-1)?.event).toEqual(fixture.events.at(-1));
  expect(await readShogiMatchReplayPage(env.APP_DB, fixture.record.id, 0, "four-shogi")).toBeNull();
  const json = JSON.stringify(fixture.record);
  const parsed = readStoredMatch(json, "shogi");
  expect(publicShogiMatchDetailSchema.parse(publicMatchDetail(parsed, new Map())).game).toEqual(
    fixture.record.game,
  );
  expect(() => readStoredMatch(json, "four-shogi")).toThrow();
  expect(() =>
    readStoredMatch(
      JSON.stringify({ ...fixture.record, participants: fixture.record.participants.slice(0, 1) }),
      "shogi",
    ),
  ).toThrow();
  const other = await accountFixture();
  expect(
    (
      await boundaryRequest(`/account/matches/${fixture.record.id}`, {
        headers: { Cookie: other.cookie },
      })
    ).status,
  ).toBe(404);
});
