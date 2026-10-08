import { expect, test } from "bun:test";
import {
  badgeDefinitions,
  getBadgeIds,
  getBadgeProgress,
  getEarnedBadges,
  type AccountStats,
  type BadgeId,
} from "@tetraboard/protocol";

function stats(id: BadgeId, value: number): AccountStats {
  const total = Math.max(100, value);
  const first = id === "wins" || id === "perfect-wins" ? value : 0;
  return {
    singles: {
      total: id === "games" ? value : total,
      first,
      second: id === "games" ? value : total - first,
      third: 0,
      fourth: 0,
      knockouts: id === "knockouts" ? value : first * 3,
      perfectWins: id === "perfect-wins" ? value : 0,
    },
    doubles: { total: 999999, wins: 999999, losses: 0, draws: 0 },
  };
}
for (const game of ["four-reversi", "four-shogi"] as const) {
  for (const id of getBadgeIds(game)) {
    test(`${game}/${id}: each threshold and unbounded highest-tier progress`, () => {
      const thresholds = badgeDefinitions[id].thresholds;
      for (const [index, threshold] of thresholds.entries()) {
        const before = getBadgeProgress(game, stats(id, threshold - 1)).find(
          (badge) => badge.id === id,
        )!;
        expect(before).toMatchObject({
          tier: index,
          value: threshold - 1,
          nextThreshold: threshold,
        });
        for (const value of [threshold, threshold + 1]) {
          const actual = getBadgeProgress(game, stats(id, value)).find((badge) => badge.id === id)!;
          const expectedTier = thresholds.filter((target) => value >= target).length;
          expect(actual).toMatchObject({
            tier: expectedTier,
            value,
            nextThreshold: expectedTier === 3 ? null : thresholds[expectedTier],
          });
        }
      }
      expect(
        getBadgeProgress(game, stats(id, 123456)).find((badge) => badge.id === id),
      ).toMatchObject({ tier: 3, value: 123456, nextThreshold: null });
    });
  }
}
test("game catalogs, zero progress, and earned-only output ignore doubles", () => {
  const empty: AccountStats = {
    singles: { total: 0, first: 0, second: 0, third: 0, fourth: 0, knockouts: 0, perfectWins: 0 },
    doubles: { total: 1000, wins: 1000, losses: 0, draws: 0 },
  };
  expect(getBadgeProgress("four-reversi", empty).map((badge) => badge.id)).toEqual([
    "games",
    "wins",
  ]);
  expect(getBadgeProgress("four-shogi", empty).map((badge) => badge.id)).toEqual([
    "games",
    "wins",
    "knockouts",
    "perfect-wins",
  ]);
  expect(getEarnedBadges("four-shogi", empty)).toEqual([]);
  expect(getEarnedBadges("four-shogi", stats("knockouts", 60))).toContainEqual({
    id: "knockouts",
    tier: 3,
    value: 60,
  });
});
