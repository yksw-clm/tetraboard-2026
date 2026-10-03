import { expect, test } from "bun:test";
import { splitVisibleTime } from "../src/analytics/pageAnalytics";
test("表示時間を日本時間の0時で分け、累積値を保つ", () => {
  const days = new Map<string, number>();
  splitVisibleTime(
    days,
    Date.parse("2026-10-03T23:59:50+09:00"),
    Date.parse("2026-10-04T00:00:20+09:00"),
  );
  splitVisibleTime(
    days,
    Date.parse("2026-10-04T00:00:20+09:00"),
    Date.parse("2026-10-04T00:00:30+09:00"),
  );
  expect([...days]).toEqual([
    ["2026-10-03", 10000],
    ["2026-10-04", 30000],
  ]);
});
