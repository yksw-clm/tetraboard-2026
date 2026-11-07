import { expect, test } from "bun:test";
import type { TournamentPublic } from "@tetraboard/protocol";
import {
  tournamentDate,
  tournamentListDate,
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

test("大会一覧は日本時間の同日なら終了日を省略し、日付をまたぐ場合は両日を表示する", () => {
  const now = Date.parse("2026-11-07T00:00:00Z");
  expect(
    tournamentListDate(Date.parse("2026-10-31T09:35:00Z"), Date.parse("2026-10-31T10:35:00Z"), now),
  ).toBe("10/31(土) 18:35〜19:35");
  expect(
    tournamentListDate(Date.parse("2026-11-07T14:30:00Z"), Date.parse("2026-11-07T15:30:00Z"), now),
  ).toBe("11/7(土) 23:30〜11/8(日) 00:30");
  expect(
    tournamentListDate(Date.parse("2026-11-07T15:00:00Z"), Date.parse("2026-11-07T16:00:00Z"), now),
  ).toBe("11/8(日) 00:00〜01:00");
});

test("大会一覧は今年以外や年をまたぐ大会に日本時間の年を表示する", () => {
  const now = Date.parse("2026-12-31T15:00:00Z");
  expect(
    tournamentListDate(Date.parse("2026-10-31T09:35:00Z"), Date.parse("2026-10-31T10:35:00Z"), now),
  ).toBe("2026/10/31(土) 18:35〜19:35");
  expect(
    tournamentListDate(Date.parse("2026-12-31T14:30:00Z"), Date.parse("2026-12-31T15:30:00Z"), now),
  ).toBe("2026/12/31(木) 23:30〜2027/1/1(金) 00:30");
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
