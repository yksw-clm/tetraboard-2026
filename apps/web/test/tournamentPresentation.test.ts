import { expect, test } from "bun:test";
import type { TournamentPublic } from "@tetraboard/protocol";
import {
  tournamentDate,
  tournamentRemaining,
} from "../src/features/tournaments/tournamentPresentation";

test("日本時間の注釈を省略しても、日時の変換と既定の表記を保つ", () => {
  const starts = Date.parse("2026-10-26T15:00:00Z");
  const ends = Date.parse("2026-10-26T16:00:00Z");
  const lobby = tournamentDate(starts, ends, { showTimeZone: false });
  expect(lobby).toContain("10月27日");
  expect(lobby).toContain("00:00");
  expect(lobby).toContain("01:00");
  expect(lobby).not.toContain("日本時間");
  expect(tournamentDate(starts, ends)).toBe(`${lobby}〈日本時間〉`);
});

const tournament: TournamentPublic = {
  id: 1,
  name: "大会",
  description: "",
  rulesDescription: "",
  startsAtMs: 0,
  endsAtMs: 0,
  status: "active",
  entryCount: 0,
  waitingCount: 0,
  playingCount: 0,
  pendingCount: 0,
  completedCount: 0,
  ruleVersion: 1,
  finalizedAtMs: null,
};
for (const [minutes, expected] of [
  [59, "59分"],
  [60, "1時間00分"],
  [61, "1時間01分"],
  [1428, "23時間48分"],
  [1440, "24時間00分"],
] as const) {
  test(`大会の残り${minutes}分を${expected}と表示する`, () => {
    const now = 1_000_000;
    expect(tournamentRemaining({ ...tournament, endsAtMs: now + minutes * 60_000 }, now)).toBe(
      `終了まであと${expected}`,
    );
  });
}
test("残り時間を分単位で切り上げ、切り上げ後の60分から時間表示にする", () => {
  const now = 1_000_000;
  for (const [remainingMs, expected] of [
    [1, "1分"],
    [60_001, "2分"],
    [59 * 60_000 + 1000, "1時間00分"],
    [60 * 60_000 + 1000, "1時間01分"],
  ] as const)
    expect(tournamentRemaining({ ...tournament, endsAtMs: now + remainingMs }, now)).toBe(
      `終了まであと${expected}`,
    );
});
test("終了時刻の一致と期限後は残り0分を下限にする", () => {
  const endsAtMs = 1_000_000;
  for (const now of [endsAtMs, endsAtMs + 1, endsAtMs + 86_400_000])
    expect(tournamentRemaining({ ...tournament, endsAtMs }, now)).toBe("終了まであと0分");
});
