import { expect, test } from "bun:test";
import {
  fitElo,
  pairs,
  profiles,
  summarize,
  type OpeningScores,
} from "../scripts/reversiCalibrationStatistics";

test("Eloは既存Lv2を1500に固定し、引き分けと完勝を有限の値で扱う", () => {
  const draws: OpeningScores = pairs.map(() => [0.5, 0.5]);
  expect(Object.values(fitElo([draws]))).toEqual(profiles.map(() => 1500));

  const strongerB: OpeningScores = pairs.map(() => [0, 0]);
  const elo = fitElo([strongerB, strongerB]);
  expect(elo.local2).toBe(1500);
  for (const { a, b } of pairs) {
    expect(Number.isFinite(elo[b])).toBe(true);
    expect(elo[b]).toBeGreaterThan(elo[a]);
  }
});

test("評価データを替えても較正Eloを保ち、予測誤差だけが変わる", () => {
  const strongerB: OpeningScores = pairs.map(() => [0, 0]);
  const strongerA: OpeningScores = pairs.map(() => [1, 1]);
  const calibration = [strongerB, strongerB];
  const same = summarize(calibration, [strongerB], 4);
  const reversed = summarize(calibration, [strongerA], 4);
  expect(same.ratings).toEqual(reversed.ratings);
  expect(same.evaluation.improvement95[0]).toBeGreaterThan(0);
  expect(reversed.evaluation.improvement95[1]).toBeLessThan(0);
});
