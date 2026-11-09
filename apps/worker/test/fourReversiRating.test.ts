import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  fourReversiRatingMethod,
  initialFourReversiRating,
  rateFourReversi,
} from "../../../packages/ai/fourReversiRating";
import { accountFixture } from "./accountFixtures";
import { boundaryRequest } from "./roomBoundaryFixtures";
import { fixtureRecord } from "./matchFixtures";
import { namedCpuProfile } from "../src/matchmaking/cpuProfiles";
import { writeMatch, type MatchRecord } from "../src/rooms/matchStore";
import { readFourReversiPlacement } from "../src/rooms/fourReversiRating";

function ratedRecord(ids: string[], index: number): MatchRecord {
  const record = fixtureRecord(ids[0]!, index);
  record.settings.timeControl = { mainTimeMs: 180_000, byoyomiMs: 0 };
  const profile = namedCpuProfile("lv3-v1");
  const cpu: NonNullable<MatchRecord["fourReversiRating"]>["cpu"] = {};
  record.participants = record.participants.map(({ id, name, color, seat }, position) => {
    const accountId = ids[position];
    if (accountId) return { id, name, color, seat, kind: "human", accountId };
    cpu[color] = { mu: 25, sigma: 1, profileId: profile.id, profileHash: profile.hash };
    return { id, name, color, seat, kind: "cpu", level: 2, cpuProfile: profile };
  });
  record.fourReversiRating = {
    method: fourReversiRatingMethod,
    calibrationVersion: "test-v1",
    cpu,
  };
  return record;
}

async function changes(matchId: string) {
  return (
    await env.APP_DB.prepare(`
    SELECT account_id, mu_before, mu_after, sigma_before, sigma_after, rated_games, human_games
    FROM four_reversi_rating_changes WHERE match_id=? ORDER BY account_id
  `)
      .bind(matchId)
      .all<{
        account_id: string;
        mu_before: number;
        mu_after: number;
        sigma_before: number;
        sigma_after: number;
        rated_games: number;
        human_games: number;
      }>()
  ).results;
}

test("同率1位の同じ事前推定は同じ結果となり、確定順位で更新する", () => {
  const prior = Array(4).fill(initialFourReversiRating);
  const tied = rateFourReversi(prior, [3, 1, 4, 1]);
  expect(tied[1]).toEqual(tied[3]);
  expect(tied[1]!.sigma).toBeGreaterThan(tied[0]!.sigma);
  expect(tied[0]!.mu).toBeGreaterThan(tied[2]!.mu);
  expect(() => rateFourReversi(prior, [1, 1, 2, 4])).toThrow();
});

test("人間1人とCPU3人の5局目で認定され、固定CPUは更新せず、再保存も一度だけ反映する", async () => {
  const { id } = await accountFixture();
  for (let index = 1; index <= 4; index++) await writeMatch(env.APP_DB, ratedRecord([id], index));
  expect(await readFourReversiPlacement(env.APP_DB, id)).toEqual({ status: "placement", games: 4 });
  const fifth = ratedRecord([id], 5);
  await Promise.all([writeMatch(env.APP_DB, fifth), writeMatch(env.APP_DB, fifth)]);
  expect(await readFourReversiPlacement(env.APP_DB, id)).toEqual({
    status: "rated",
    humanPlayed: false,
  });
  const fourthChanges = await changes(ratedRecord([id], 4).id);
  expect(await changes(fifth.id)).toEqual([
    expect.objectContaining({
      account_id: id,
      mu_before: fourthChanges[0]!.mu_after,
      sigma_before: fourthChanges[0]!.sigma_after,
      rated_games: 5,
      human_games: 0,
    }),
  ]);
  const replay = await boundaryRequest(`/matches/${fifth.id}`);
  expect(replay.status).toBe(200);
  expect((await replay.json<{ match: unknown }>()).match).not.toHaveProperty("fourReversiRating");
});

test("CPU混在局は全員の確定順位で人間2人を更新し、通常戦と代替手使用局は対象外", async () => {
  const ids = await Promise.all([accountFixture(), accountFixture()]).then((users) =>
    users.map((u) => u.id),
  );
  const excluded = ratedRecord(ids, 1);
  excluded.fourReversiRating!.usedFallback = true;
  await writeMatch(env.APP_DB, excluded);
  expect(await changes(excluded.id)).toEqual([]);
  expect(
    await env.APP_DB.prepare("SELECT id FROM matches WHERE id=?").bind(excluded.id).first(),
  ).toBeTruthy();
  const normal = ratedRecord(ids, 2);
  delete normal.fourReversiRating;
  await writeMatch(env.APP_DB, normal);
  expect(await changes(normal.id)).toEqual([]);

  const mixed = ratedRecord(ids, 3);
  await writeMatch(env.APP_DB, mixed);
  const rows = await changes(mixed.id);
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.rated_games === 1 && row.human_games === 1)).toBe(true);
  expect(rows.find((row) => row.account_id === ids[0])!.mu_after).toBeLessThan(
    rows.find((row) => row.account_id === ids[1])!.mu_after,
  );
});

test("同じ人間を含む別々の終局を同時保存しても前の推定を失わない", async () => {
  const { id } = await accountFixture();
  const matches = [ratedRecord([id], 1), ratedRecord([id], 2)];
  await Promise.all(matches.map((match) => writeMatch(env.APP_DB, match)));
  const [first, second] = (await Promise.all(matches.map((match) => changes(match.id))))
    .flat()
    .sort((a, b) => a.rated_games - b.rated_games);
  expect(first!.rated_games).toBe(1);
  expect(second!.rated_games).toBe(2);
  expect(second!.mu_before).toBe(first!.mu_after);
  expect(second!.sigma_before).toBe(first!.sigma_after);
});
