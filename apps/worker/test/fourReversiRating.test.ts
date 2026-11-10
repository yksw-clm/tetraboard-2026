import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { fourReversiRatingSummarySchema } from "@tetraboard/protocol";
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
import { fourReversiPublicRating } from "../src/rooms/fourReversiRating";

const ratingPath = "/matchmaking/four-reversi/rating";

async function readRating(headers: HeadersInit) {
  const response = await boundaryRequest(ratingPath, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return fourReversiRatingSummarySchema.parse(await response.json());
}

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
  const { id, headers } = await accountFixture();
  expect((await boundaryRequest(ratingPath)).status).toBe(401);
  expect(await readRating(headers)).toEqual({ status: "placement", games: 0 });
  for (let index = 1; index <= 4; index++) await writeMatch(env.APP_DB, ratedRecord([id], index));
  expect(await readRating(headers)).toEqual({ status: "placement", games: 4 });
  const fifth = ratedRecord([id], 5);
  await Promise.all([writeMatch(env.APP_DB, fifth), writeMatch(env.APP_DB, fifth)]);
  const fifthChanges = await changes(fifth.id);
  const publicRating = Math.round(1500 + 50 * (fifthChanges[0]!.mu_after - 25));
  expect(await readRating(headers)).toEqual({
    status: "rated",
    rating: publicRating,
    rank: "ブロンズ3",
    humanPlayed: false,
  });
  const fourthChanges = await changes(ratedRecord([id], 4).id);
  const previous = fourthChanges[0]!;
  const cpu = { mu: 25, sigma: 1 };
  const [expected] = rateFourReversi(
    [{ mu: previous.mu_after, sigma: previous.sigma_after }, cpu, cpu, cpu],
    [4, 3, 2, 1],
  );
  expect(fifthChanges).toEqual([
    expect.objectContaining({
      account_id: id,
      mu_before: fourthChanges[0]!.mu_after,
      sigma_before: fourthChanges[0]!.sigma_after,
      mu_after: expected!.mu,
      rated_games: 5,
      human_games: 0,
    }),
  ]);
  const replay = await boundaryRequest(`/matches/${fifth.id}`);
  expect(replay.status).toBe(200);
  expect((await replay.json<{ match: unknown }>()).match).not.toHaveProperty("fourReversiRating");
});

test("公開レートを整数に丸めて、全ランク境界を判定する", () => {
  const ranks = [
    "ブロンズ3",
    "ブロンズ2",
    "ブロンズ1",
    "シルバー3",
    "シルバー2",
    "シルバー1",
    "ゴールド3",
    "ゴールド2",
    "ゴールド1",
    "プラチナ3",
    "プラチナ2",
    "プラチナ1",
    "ダイヤモンド3",
    "ダイヤモンド2",
    "ダイヤモンド1",
  ];
  for (let i = 1; i < ranks.length; i++) {
    const boundary = 1100 + i * 100;
    const mu = 25 + (boundary - 1500) / 50;
    expect(fourReversiPublicRating(mu - 0.012)).toEqual({
      rating: boundary - 1,
      rank: ranks[i - 1],
    });
    expect(fourReversiPublicRating(mu - 0.008)).toEqual({
      rating: boundary,
      rank: ranks[i],
    });
  }
  expect(fourReversiPublicRating(0).rank).toBe("ブロンズ3");
  expect(fourReversiPublicRating(60).rank).toBe("ダイヤモンド1");
});

test("人間4人の認定局とCPU混在局の結果を同じ公開レートに反映する", async () => {
  const users = await Promise.all(Array.from({ length: 4 }, () => accountFixture()));
  const target = users[0]!;
  const ids = users.map((user) => user.id);
  for (let i = 1; i <= 5; i++) {
    const order = i % 2 ? [...ids.slice(1), target.id] : ids;
    await writeMatch(env.APP_DB, ratedRecord(order, i));
  }
  const before = await readRating(target.headers);
  expect(before.status).toBe("rated");
  if (before.status !== "rated") throw Error("認定済みのレートが必要です");
  expect(before.humanPlayed).toBe(true);
  const mixed = ratedRecord(ids.slice(0, 2), 6);
  await writeMatch(env.APP_DB, mixed);
  const targetChange = (await changes(mixed.id)).find((row) => row.account_id === target.id)!;
  expect(before.rating).toBe(Math.round(1500 + 50 * (targetChange.mu_before - 25)));
  const after = await readRating(target.headers);
  expect(after).toEqual({
    status: "rated",
    ...fourReversiPublicRating(targetChange.mu_after),
    humanPlayed: true,
  });
  expect(fourReversiPublicRating(targetChange.mu_after).rating).toBeLessThan(before.rating);
});

test.each([
  { seats: 2, maxChange: 24 },
  { seats: 4, maxChange: 32 },
])(
  "認定後は人間$seats席の対局で保存する増減を最大$maxChangeに制限する",
  async ({ seats, maxChange }) => {
    const users = await Promise.all(Array.from({ length: 4 }, () => accountFixture()));
    const ids = users.map((user) => user.id);
    for (let index = 0; index < 5; index++) {
      const shift = index % ids.length;
      const order = [...ids.slice(shift), ...ids.slice(0, shift)];
      await writeMatch(env.APP_DB, ratedRecord(order, index + 1));
    }
    const sixth = ratedRecord(ids.slice(0, seats), 6);
    await Promise.all([writeMatch(env.APP_DB, sixth), writeMatch(env.APP_DB, sixth)]);
    const rows = await changes(sixth.id);
    expect(rows).toHaveLength(seats);
    const deltas = ids.slice(0, seats).map((id) => {
      const row = rows.find((change) => change.account_id === id)!;
      expect(row.rated_games).toBe(6);
      return (
        fourReversiPublicRating(row.mu_after).rating - fourReversiPublicRating(row.mu_before).rating
      );
    });
    expect(deltas[0]).toBe(-maxChange);
    expect(deltas.every((delta) => Math.abs(delta) <= maxChange)).toBe(true);
    if (seats === 4) expect(deltas[3]).toBe(maxChange);
  },
);

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
