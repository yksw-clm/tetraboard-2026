import { expect, test } from "bun:test";
import { pageAcquisition, splitVisibleTime } from "../src/analytics/pageAnalytics";
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
test("閲覧の付加情報は参照元ホストと3種類のUTMだけに限定する", () => {
  expect(
    pageAcquisition(
      "https://www.google.com/search?q=SECRET",
      "?invite=SECRET&utm_source=X%20%E5%91%8A%E7%9F%A5&utm_medium=social&utm_campaign=20261019_event&utm_term=SECRET",
      "tetraboard.net",
    ),
  ).toEqual({
    referrer: "www.google.com",
    source: "X",
    medium: "social",
    campaign: "20261019_event",
  });
});
