import { expect, test } from "bun:test";
import { comparePilotLine, pilotPairedComparisons } from "../bench/strengthPilotDiagnostics";
import { createStrengthOpening, type RecordedGame } from "../bench/strength";
import type { FourShogiAction } from "@tetraboard/four-shogi";
import { sides } from "@tetraboard/four-shogi";
import { pilotStrategies } from "../bench/strengthPilotResults";

const move = (x: number, y: number, toX: number, toY: number): FourShogiAction => ({
  type: "movePiece",
  from: { x, y },
  to: { x: toX, y: toY },
  promote: false,
});

test("PV比較はJSONのキー順に依存せず、次の自手まで読むことと実際の一致を区別する", () => {
  const line = [
    { side: "south" as const, action: move(4, 6, 4, 5) },
    { side: "west" as const, action: move(6, 4, 5, 4) },
    { side: "south" as const, action: move(4, 5, 4, 4) },
  ];
  const reordered: FourShogiAction = {
    promote: false,
    to: { y: 5, x: 4 },
    type: "movePiece",
    from: { y: 6, x: 4 },
  };
  const same = comparePilotLine(
    line,
    [{ type: "action", side: "south", action: reordered }],
    "south",
  );
  expect(same.matchingPlies).toBe(1);
  expect(same.firstDivergence).toBeNull();
  expect(same.pvReachesNextOwnMove).toBe(true);
  expect(same.actualPrefixExhausted).toBe(true);
  const different = comparePilotLine(
    line,
    [
      { type: "action", ...line[0] },
      { type: "action", side: "west", action: move(6, 4, 7, 4) },
    ],
    "south",
  );
  expect(different.firstDivergence).toEqual({ at: 1, expectedSide: "west", actualSide: "west" });
  expect(different.pvReachesNextOwnMove).toBe(true);
  expect(different.actualPrefixExhausted).toBe(false);
});

test("対応差はseed単位で向きを固定し、欠けた条件や未終局を敗北へ置換しない", async () => {
  const opening = await createStrengthOpening(9430400, false);
  const games = [false, true].flatMap((restricted) =>
    sides.flatMap((seat) =>
      pilotStrategies.map(
        (strategy) =>
          ({
            jobId: `${restricted}/${seat}/${strategy}`,
            searchStrategy: strategy,
            restricted,
            replay: opening.replay,
            sample: {
              seed: 9430400,
              seat,
              status: "finished",
              soleFirst: strategy === "adaptive",
              rank: strategy === "adaptive" ? 1 : 3,
            },
          }) as unknown as RecordedGame,
      ),
    ),
  );
  const result = pilotPairedComparisons(games);
  expect(result.independentSeeds).toBe(1);
  expect(result.interval).toBeNull();
  expect(result.comparisons[0].primarySoleFirstRateDifference).toBe(-1);
  expect(result.comparisons[0].primaryMeanRankDifference).toBe(2);
  expect(result.comparisons[0].matchedCells).toBe(8);
  expect(
    pilotPairedComparisons(games.slice(1)).comparisons.every(
      (pair) => pair.primarySoleFirstRateDifference === null,
    ),
  ).toBe(true);
  games[0].sample.status = "unfinished";
  games[0].sample.rank = null;
  expect(pilotPairedComparisons(games).comparisons[0].matchedCells).toBe(7);
  expect(() => pilotPairedComparisons([...games, games[0]])).toThrow("重複");
});
