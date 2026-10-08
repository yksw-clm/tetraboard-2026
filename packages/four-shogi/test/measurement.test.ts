import { expect, test } from "bun:test";
import {
  summarizeMatches,
  summarizeTimes,
  openingPosition,
  seededRandom,
  type MatchSample,
} from "../bench/measurement";

test("未終局と引分を単独勝利に含めず、開始系列単位で集計する", () => {
  const base: MatchSample = {
    seed: 10,
    seat: "south",
    status: "finished",
    moves: 10,
    rank: 1,
    win: false,
    draw: true,
    score: 0,
  };
  const result = summarizeMatches([
    base,
    { ...base, seat: "west", win: true, draw: false, score: 1 },
    { ...base, seed: 20, seat: "north", status: "unfinished", rank: null, draw: false },
    { ...base, seed: 20, seat: "east", rank: 4, draw: false },
  ]);
  expect(result.games).toBe(4);
  expect(result.openingSeries).toBe(2);
  expect(result.winRate).toBe(0.25);
  expect(result.drawRate).toBe(0.25);
  expect(result.unfinishedRate).toBe(0.25);
  expect(result.averageRank).toBe(2);
  expect(result.seatCounts).toEqual({ south: 1, west: 1, north: 1, east: 1 });
});

test("性能集計は遅い標本を含むp95と最大時間を返す", () => {
  expect(summarizeTimes([2, 1, 100])).toEqual({
    samples: 3,
    meanMs: 103 / 3,
    p95Ms: 100,
    maxMs: 100,
  });
  expect(() => summarizeTimes([])).toThrow();
});

test("同じseedと設定から同じ合法な開始系列を再現する", () => {
  expect(openingPosition("singles", true, 1000)).toEqual(openingPosition("singles", true, 1000));
  expect(openingPosition("singles", true, 1001)).not.toEqual(
    openingPosition("singles", true, 1000),
  );
  const first = seededRandom(22);
  const second = seededRandom(22);
  expect(Array.from({ length: 10 }, first)).toEqual(Array.from({ length: 10 }, second));
});
