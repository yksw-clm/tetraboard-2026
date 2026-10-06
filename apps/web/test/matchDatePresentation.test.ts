import { expect, test } from "bun:test";
import { formatMatchDate } from "../src/features/matches/matchDatePresentation";

const startedAtMs = new Date(2026, 9, 6, 14, 20).getTime();
const minuteMs = 60_000;
const hourMs = 60 * minuteMs;

test("最近の対局は1時間以内を切り捨てた分数で表示する", () => {
  for (const [elapsedMs, label] of [
    [0, "0分前"],
    [minuteMs - 1, "0分前"],
    [minuteMs, "1分前"],
    [12 * minuteMs + 45_000, "12分前"],
    [hourMs - 1, "59分前"],
    [hourMs, "60分前"],
  ] as const) {
    expect(formatMatchDate(startedAtMs, startedAtMs + elapsedMs)).toBe(label);
  }
});

test("1時間超から24時間以内は切り捨てた時間数、それより古い対局は日時を表示する", () => {
  expect(formatMatchDate(startedAtMs, startedAtMs + hourMs + 1)).toBe("1時間前");
  expect(formatMatchDate(startedAtMs, startedAtMs + 3 * hourMs + 59 * minuteMs)).toBe("3時間前");
  expect(formatMatchDate(startedAtMs, startedAtMs + 24 * hourMs - 1)).toBe("23時間前");
  expect(formatMatchDate(startedAtMs, startedAtMs + 24 * hourMs)).toBe("24時間前");
  expect(formatMatchDate(startedAtMs, startedAtMs + 24 * hourMs + 1)).toBe("2026/10/06 14:20");
  expect(formatMatchDate(startedAtMs, startedAtMs + 48 * hourMs)).toBe("2026/10/06 14:20");
});

test("日付をまたいでも経過時間で判定し、未来の開始時刻と本人用カードは日時を表示する", () => {
  const previousDay = new Date(2026, 9, 5, 23, 30).getTime();
  const today = new Date(2026, 9, 6, 0, 45).getTime();
  expect(formatMatchDate(previousDay, today)).toBe("1時間前");
  expect(formatMatchDate(startedAtMs, startedAtMs - minuteMs)).toBe("2026/10/06 14:20");
  expect(formatMatchDate(startedAtMs)).toBe("2026/10/06 14:20");
});
