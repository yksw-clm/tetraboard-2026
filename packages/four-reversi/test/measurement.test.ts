import { expect, test } from "bun:test";
import { createInitialState, getLegalMoves } from "../src/index";
import {
  openingPosition,
  playMatch,
  seededRandom,
  summarizeMatches,
  summarizeTimes,
} from "../bench/measurement";
import { endgameCases, performancePositions } from "../bench/positions";
import { solveEndgame } from "../bench/oracle";

test("開始系列の再現性と性能集合の件数を維持する", () => {
  expect(openingPosition("singles", 1000)).toEqual(openingPosition("singles", 1000));
  expect(openingPosition("singles", 1000).moveNumber).toBe(12);
  expect(Array.from({ length: 4 }, seededRandom(1))).toEqual(
    Array.from({ length: 4 }, seededRandom(1)),
  );
  expect(performancePositions().length).toBeGreaterThanOrEqual(32);
});

test("集計は未終局を勝ちや引分へ置換せず、重複を拒否する", () => {
  const sample = playMatch(
    createInitialState("singles"),
    (s) => getLegalMoves(s)[0],
    (s) => getLegalMoves(s)[0],
    "black",
    1,
    1,
  );
  expect(sample.status).toBe("unfinished");
  expect(sample.score).toBe(0);
  expect(summarizeMatches([sample]).unfinishedRate).toBe(1);
  expect(() => summarizeMatches([sample, sample])).toThrow("重複");
  expect(summarizeTimes([1, 2, 3, 4, 5])).toEqual({ samples: 5, meanMs: 3, p95Ms: 5, maxMs: 5 });
});

test("調整用と最終用の終盤原局面を分離し、oracleは合法な最適手を返す", () => {
  const training = endgameCases(10000, 25);
  const validation = endgameCases(30000, 25);
  const keys = new Set(training.map((entry) => JSON.stringify(entry.state.board)));
  expect(validation.some((entry) => keys.has(JSON.stringify(entry.state.board)))).toBe(false);
  for (const { state } of [...training, ...validation]) {
    const expected = solveEndgame(state);
    expect(expected.moves.length).toBeGreaterThan(0);
    expect(
      expected.moves.every((p) => getLegalMoves(state).some((q) => p.x === q.x && p.y === q.y)),
    ).toBe(true);
  }
});
