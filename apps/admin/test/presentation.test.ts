import { expect, test } from "bun:test";
import { defaultPeriod, percent, duration } from "../src/presentation";
test("日本時間の月初・年跨ぎと30日の期間を算出する", () => {
  const at = Date.parse("2026-12-31T15:00:00Z");
  expect(defaultPeriod("day", at)).toEqual({ from: "2026-12-03", to: "2027-01-01" });
  expect(defaultPeriod("month", at)).toEqual({ from: "2026-02-01", to: "2027-01-01" });
});
test("未計測の率と0の率を区別する", () => {
  expect(percent(null)).toBe("—");
  expect(percent(0)).toBe("0.0%");
  expect(percent(1 / 3)).toBe("33.3%");
  expect(duration(null)).toBe("—");
  expect(duration(60000)).toBe("1分");
});
