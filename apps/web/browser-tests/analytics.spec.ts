import { expect, test, type Page } from "@playwright/test";
import { mockLobby } from "./fixtures";
async function telemetry(page: Page) {
  const views: { id: string; page: string; game: string | null }[] = [];
  const times: { id: string; days: { day: string; milliseconds: number }[] }[] = [];
  await mockLobby(page);
  await page.route("**/api/analytics/pageviews", (route) => {
    views.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/analytics/dwell", (route) => {
    times.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  return { views, times };
}
test("画面遷移と再読み込みを計測し、URLや招待情報を送信せずCookieを保持する", async ({
  page,
  context,
}) => {
  const data = await telemetry(page);
  await page.goto("/games/four-reversi?invite=private-value");
  await expect.poll(() => data.views.length).toBe(1);
  expect(data.views[0]).toMatchObject({ page: "lobby", game: "four-reversi" });
  expect(JSON.stringify(data.views)).not.toContain("private-value");
  const first = (await context.cookies()).find(
    (cookie) => cookie.name === "tetraboard-2026.analytics",
  );
  expect(first?.value).toMatch(/^[0-9a-f-]{36}$/);
  await page.reload();
  await expect.poll(() => data.views.length).toBe(2);
  const second = (await context.cookies()).find(
    (cookie) => cookie.name === "tetraboard-2026.analytics",
  );
  expect(second?.value).toBe(first?.value);
  expect(data.views[1].id).not.toBe(data.views[0].id);
  await page.getByRole("link", { name: "四人将棋", exact: true }).click();
  await expect.poll(() => data.views.length).toBe(3);
  expect(data.views[2]).toMatchObject({ page: "lobby", game: "four-shogi" });
});
test("30秒の送信・複数タブの排他と離脱後の計測引き継ぎ", async ({ page, context }) => {
  const first = await telemetry(page);
  await page.clock.install({ time: new Date("2026-10-03T12:00:00+09:00") });
  await page.goto("/games/four-reversi");
  await page.bringToFront();
  await expect.poll(() => first.views.length).toBe(1);
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await page.clock.runFor(31000);
  await expect.poll(() => first.times.length).toBeGreaterThan(0);
  expect(first.times.at(-1)!.days[0].milliseconds).toBeGreaterThanOrEqual(29000);
  const other = await context.newPage();
  const second = await telemetry(other);
  await other.clock.install({ time: new Date("2026-10-03T12:00:31+09:00") });
  await other.goto("/games/four-shogi");
  await other.bringToFront();
  await expect.poll(() => second.views.length).toBe(1);
  // ヘッドレス環境は両タブをvisibleとして扱うため、共有ロックによる排他を直接確認します。
  await other.clock.runFor(31000);
  expect(second.times).toHaveLength(0);
  await page.goto("about:blank");
  await expect.poll(() => first.times.length).toBeGreaterThanOrEqual(2);
  await other.clock.runFor(31000);
  await expect.poll(() => second.times.length).toBeGreaterThan(0);
  await other.goto("/account");
  await expect.poll(() => second.times.length).toBeGreaterThanOrEqual(2);
});
test("計測の取得失敗でゲームの入口を妨げない", async ({ page }) => {
  await mockLobby(page);
  await page.route("**/api/analytics/**", (route) => route.abort());
  await page.goto("/games/four-reversi");
  await page.getByRole("button", { name: /すぐ遊ぶ/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("非表示中は滞在時間と送信を増やさず、再表示後に計測を再開する", async ({ page }) => {
  const data = await telemetry(page);
  await page.clock.install({ time: new Date("2026-10-03T12:00:00+09:00") });
  await page.goto("/games/four-reversi");
  await page.bringToFront();
  await expect.poll(() => data.views.length).toBe(1);
  await page.clock.runFor(31000);
  await expect.poll(() => data.times.length).toBeGreaterThan(0);
  // ヘッドレス環境ではタブが非表示にならないため、ブラウザの表示状態の境界を置き換えます。
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => data.times.length).toBeGreaterThanOrEqual(2);
  const hiddenCount = data.times.length;
  const hiddenTime = data.times.at(-1)!.days[0].milliseconds;
  await page.clock.runFor(61000);
  expect(data.times).toHaveLength(hiddenCount);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(31000);
  await expect.poll(() => data.times.length).toBeGreaterThan(hiddenCount);
  const additional = data.times.at(-1)!.days[0].milliseconds - hiddenTime;
  expect(additional).toBeGreaterThanOrEqual(27000);
  expect(additional).toBeLessThanOrEqual(31000);
});
