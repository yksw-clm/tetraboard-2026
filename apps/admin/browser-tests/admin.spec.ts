import { expect, test, type Page } from "@playwright/test";
import { analyticsMetricsSchema } from "@tetraboard/protocol";
const zero = Object.fromEntries(
  Object.keys(analyticsMetricsSchema.shape).map((key) => [key, key.endsWith("Rate") ? null : 0]),
);
const metrics = {
  ...zero,
  visitors: 10,
  pageViews: 30,
  started: 4,
  completed: 3,
  abandoned: 1,
  cpuMatches: 2,
  humanMatches: 2,
  singles: 4,
  completionRate: 0.75,
  startRate: 0.4,
};
async function session(page: Page) {
  await page.route("**/api/admin/session", (route) =>
    route.fulfill({ json: { name: "管理者", username: "admin" } }),
  );
}
for (const width of [390, 768, 1440])
  test(`指標・ゲーム切替・日別/月別・除外・更新失敗 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await session(page);
    let fail = false;
    await page.route("**/api/admin/analytics?*", (route) => {
      const url = new URL(route.request().url());
      return route.fulfill(
        fail
          ? { status: 503, json: { message: "集計できません。" } }
          : {
              json: {
                collectedFromMs: 1790953200000,
                asOfMs: 1791039600000,
                totalUsers: 5,
                summary: metrics,
                buckets: [
                  {
                    period: url.searchParams.get("bucket") === "month" ? "2026-10" : "2026-10-03",
                    metrics,
                  },
                ],
              },
            },
      );
    });
    await page.goto("/admin/");
    await expect(page.getByRole("heading", { name: "全体概要", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "管理画面" }).getByRole("link")).toHaveText([
      "全体概要",
      "四人リバーシ",
      "四人将棋",
      "登録ユーザー",
      "フィードバック",
    ]);
    const reversi = page.waitForRequest((request) => request.url().includes("game=four-reversi"));
    await page.getByRole("link", { name: "四人リバーシ", exact: true }).click();
    await reversi;
    await expect(page).toHaveURL(/\/admin\/games\/four-reversi$/);
    await expect(page.getByRole("heading", { name: "四人リバーシ", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: /折れ線グラフ/ })).toBeVisible();
    await expect(page.getByRole("table")).toContainText("75.0%");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const month = page.waitForRequest((request) => request.url().includes("bucket=month"));
    await page.getByLabel("集計単位").selectOption("month");
    await month;
    await expect(page.getByRole("table")).toContainText("2026-10");
    const periodChanged = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === "/api/admin/analytics" &&
        url.searchParams.get("from") === "2026-10-01" &&
        url.searchParams.get("to") === "2026-10-02"
      );
    });
    await page.getByLabel("開始日").fill("2026-10-01");
    await page.getByLabel("終了日").fill("2026-10-02");
    await periodChanged;
    const internal = page.waitForRequest((request) =>
      request.url().includes("includeInternal=true"),
    );
    await page.getByLabel("本人・テストを含める").check();
    await internal;
    const shogi = page.waitForRequest((request) => request.url().includes("game=four-shogi"));
    await page.getByRole("link", { name: "四人将棋" }).click();
    await shogi;
    await expect(page.getByRole("heading", { name: "四人将棋", exact: true })).toBeVisible();
    fail = true;
    await page.getByRole("button", { name: "更新", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("表示済み");
    await expect(page.getByRole("table")).toContainText("75.0%");
    fail = false;
    await page.getByRole("button", { name: "再試行" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "四人将棋", exact: true })).toBeVisible();
  });
test("登録一覧の未完了・壊れたアイコン・検索・追加失敗と再試行", async ({ page }) => {
  await session(page);
  let failMore = true;
  const users = [
    {
      name: "ユーザー",
      username: "player",
      avatarUrl: "/missing.webp",
      createdAtMs: 1791039600000,
      profileCompleted: true,
    },
    {
      name: "",
      username: null,
      avatarUrl: null,
      createdAtMs: 1791039600000,
      profileCompleted: false,
    },
  ];
  await page.route("**/api/admin/users?*", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("cursor"))
      return route.fulfill(
        failMore
          ? { status: 503, json: { message: "取得できません。" } }
          : { json: { users: [{ ...users[0], username: "next" }], nextCursor: null } },
      );
    return route.fulfill({
      json: {
        users: url.searchParams.get("search") ? [users[0]] : users,
        nextCursor: url.searchParams.get("search") ? null : "next-page",
      },
    });
  });
  await page.goto("/admin/users");
  await expect(page.getByRole("table")).toContainText("未完了");
  await page.getByRole("button", { name: "もっと見る" }).click();
  await expect(page.getByRole("alert")).toContainText("表示済み");
  await expect(page.getByRole("table")).toContainText("@player");
  failMore = false;
  await page.getByRole("button", { name: "もっと見る" }).click();
  await expect(page.getByRole("table")).toContainText("@next");
  await page.getByLabel("名前・IDで検索").fill("@player");
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.getByRole("table")).not.toContainText("@next");
  await expect(page.getByRole("table")).toContainText("@player");
});
for (const status of [401, 403, 503])
  test(`認証エラー${status}は管理データを取得しない`, async ({ page }) => {
    let fetched = false;
    await page.route("**/api/admin/session", (route) =>
      route.fulfill({ status, json: { message: "権限を確認してください。" } }),
    );
    await page.route("**/api/admin/analytics?*", (route) => {
      fetched = true;
      return route.fulfill({ status: 500 });
    });
    await page.goto("/admin/");
    await expect(page.getByRole("alert")).toBeVisible();
    expect(fetched).toBe(false);
    if (status === 401)
      await expect(page.getByRole("link", { name: "Googleでログイン" })).toHaveAttribute(
        "href",
        "/login?destination=admin",
      );
  });
test("空データは計測なしと表示し、0件の率を偽らない", async ({ page }) => {
  await session(page);
  await page.route("**/api/admin/analytics?*", (route) =>
    route.fulfill({
      json: {
        collectedFromMs: null,
        asOfMs: 1791039600000,
        totalUsers: 0,
        summary: zero,
        buckets: [],
      },
    }),
  );
  await page.goto("/admin/");
  await expect(page.getByRole("status")).toContainText("データはありません");
  await expect(page.getByRole("region", { name: "主要指標" })).toContainText("—");
});
