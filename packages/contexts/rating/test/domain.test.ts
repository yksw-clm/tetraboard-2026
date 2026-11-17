import { expect, test } from "bun:test";
import {
  calculateElo,
  initialFourReversiRating,
  rateFourReversi,
  publicRatingForMu,
  isPlacement,
  predictFourReversiPair,
  isRatedTimeControl,
} from "../src";

test.each([
  [1500, 1500, 1, 0, "human", 1532],
  [1500, 1500, 0, 0, "human", 1468],
  [1500, 1500, 1, 4, "human", 1532],
  [1500, 1500, 1, 5, "human", 1516],
  [1500, 1500, 1, 4, "cpu", 1524],
  [1500, 1500, 1, 5, "cpu", 1508],
  [1500, 1500, 0.5, 4, "cpu", 1500],
] as const)("Elo の移行前の固定例 %j", (rating, opponent, score, games, kind, expected) => {
  expect(calculateElo(rating, opponent, score, games, kind)).toBe(expected);
});
test("Elo の異なる更新前レートの固定例", () => {
  expect(calculateElo(1524, 1624, 0, 5, "cpu")).toBeCloseTo(1518.2410399968462, 10);
  expect(calculateElo(1516, 1468, 0.5, 6, "human")).toBeCloseTo(1513.8034754597227, 10);
});

// 移行前の packages/ai/fourReversiRating.ts を実行して得た値を固定します。
test("skill の通常計算と校正計算は移行前の値を保つ", () => {
  const ratings = Array(4).fill(initialFourReversiRating);
  expect(rateFourReversi(ratings, [1, 2, 3, 4])).toEqual([
    { mu: 27.795252672501135, sigma: 8.263571791259416 },
    { mu: 26.55291815138952, sigma: 8.17961798837266 },
    { mu: 24.689416369722096, sigma: 8.084127880168786 },
    { mu: 20.962412806387245, sigma: 8.084127880168786 },
  ]);
  expect(rateFourReversi(ratings, [1, 2, 3, 4], true)).toEqual([
    { mu: 27.795084971874736, sigma: 8.263160757613477 },
    { mu: 26.552824984374855, sigma: 8.179213704945203 },
    { mu: 24.68943500312503, sigma: 8.083731307186588 },
    { mu: 20.96265504062538, sigma: 8.083731307186588 },
  ]);
  expect(ratings).toEqual(Array(4).fill({ mu: 25, sigma: 25 / 3 }));
});
test("異なる事前推定と同率順位でも移行前の値を保つ", () => {
  expect(
    rateFourReversi(
      [
        { mu: 24, sigma: 3 },
        { mu: 28, sigma: 1 },
        { mu: 25, sigma: 2 },
        { mu: 20, sigma: 4 },
      ],
      [1, 1, 3, 4],
    ),
  ).toEqual([
    { mu: 24.23997075043801, sigma: 2.9938136823374952 },
    { mu: 28.015157466907404, sigma: 1.003349973866424 },
    { mu: 25.04750621713847, sigma: 1.9982784939068965 },
    { mu: 19.142799911026973, sigma: 3.9531674205964467 },
  ]);
});
test("席数と競技順位の検査、勝率の予測を維持する", () => {
  expect(() => rateFourReversi([], [])).toThrow("4席");
  expect(() => rateFourReversi(Array(4).fill(initialFourReversiRating), [1, 1, 2, 4])).toThrow(
    "競技順位",
  );
  expect(predictFourReversiPair(initialFourReversiRating, initialFourReversiRating)).toBe(0.5);
});
test("配置戦の境界と公開整数への変換", () => {
  expect([0, 4, 5, 6].map(isPlacement)).toEqual([true, true, false, false]);
  expect([24.988, 24.992, -5.01].map(publicRatingForMu)).toEqual([1499, 1500, -0]);
});
test("4 ゲームで新旧の時計だけを認める", () => {
  for (const game of ["shogi", "reversi", "four-shogi", "four-reversi"] as const) {
    expect(isRatedTimeControl(game, { mainTimeMs: 180000, byoyomiMs: 0 })).toBe(game !== "shogi");
    expect(isRatedTimeControl(game, { mainTimeMs: 600000, byoyomiMs: 0 })).toBe(game === "shogi");
    expect(isRatedTimeControl(game, { mainTimeMs: 300000, byoyomiMs: 30000 })).toBe(
      game === "shogi",
    );
    expect(isRatedTimeControl(game, { mainTimeMs: 300000, byoyomiMs: 0 })).toBe(game === "reversi");
    expect(isRatedTimeControl(game, { mainTimeMs: 0, byoyomiMs: 30000 })).toBe(
      game.startsWith("four-"),
    );
    expect(isRatedTimeControl(game)).toBe(false);
  }
});
