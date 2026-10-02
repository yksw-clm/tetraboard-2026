import { expect, test, type Locator } from "@playwright/test";
import { type AccountStats } from "@tetraboard/protocol";
import { mockAccount, profile } from "./accountFixtures";

const sample: AccountStats = {
  singles: { total: 12, first: 4, second: 2, third: 6, fourth: 0 },
  doubles: { total: 6, wins: 3, losses: 2, draws: 1 },
};
async function metric(section: Locator, label: string, value: string) {
  await expect(section.getByText(label, { exact: true }).locator("..").locator("dd")).toHaveText(
    value,
  );
}

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`戦績の項目と率を${width}pxで表示し、棋譜と独立してタブを切り替える`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await mockAccount(page, profile);
    let requests = 0;
    await page.route("**/api/account/stats", (route) => {
      requests++;
      return route.fulfill({ json: sample });
    });
    await page.goto("/account");
    const section = page.getByRole("region", { name: "戦績", exact: true });
    const replay = page.getByTestId("account-replay-card");
    await expect(section.getByRole("tab", { name: "シングルス" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    for (const [label, value] of [
      ["対局数", "12"],
      ["優勝数", "4"],
      ["優勝率", ".333"],
      ["2位数", "2"],
      ["2位率", ".167"],
      ["3位数", "6"],
      ["3位率", ".500"],
      ["4位数", "0"],
      ["4位率", ".000"],
    ])
      await metric(section, label, value);
    const title = await section.getByRole("heading", { name: "戦績" }).boundingBox();
    const game = await section.getByRole("button", { name: /戦績のゲーム$/ }).boundingBox();
    const tabs = await section.getByRole("tablist").boundingBox();
    expect(game!.y).toBeGreaterThan(title!.y + title!.height);
    expect(tabs!.y).toBeGreaterThan(game!.y + game!.height);
    expect(tabs!.y - (game!.y + game!.height)).toBeLessThan(30);
    const card = await page.getByTestId("account-profile-card").boundingBox();
    const stats = await section.boundingBox();
    expect(stats!.x).toBeGreaterThanOrEqual(card!.x);
    expect(stats!.x + stats!.width).toBeLessThanOrEqual(card!.x + card!.width);
    expect(stats!.y + stats!.height).toBeLessThanOrEqual(card!.y + card!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await info.attach(`stats-singles-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await section.getByRole("tab", { name: "シングルス" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(section.getByRole("tab", { name: "ダブルス" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    for (const [label, value] of [
      ["対局数", "6"],
      ["勝数", "3"],
      ["勝率", ".500"],
      ["敗数", "2"],
      ["敗率", ".333"],
    ])
      await metric(section, label, value);
    await expect(section.getByText(/引き分け/)).toHaveCount(0);
    await expect(section.getByText("優勝数", { exact: true })).toHaveCount(0);
    await expect(replay.getByRole("tab", { name: "シングルス" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await replay.getByRole("tab", { name: "ダブルス" }).click();
    await section.getByRole("tab", { name: "シングルス" }).click();
    await metric(section, "優勝率", ".333");
    await expect(replay.getByRole("tab", { name: "ダブルス" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(requests).toBe(1);
    await section.getByRole("tab", { name: "ダブルス" }).click();
    await info.attach(`stats-doubles-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
}

test("両モードの対局数ゼロは件数0・率.000を表示する", async ({ page }) => {
  await mockAccount(page, profile);
  await page.goto("/account");
  const section = page.getByRole("region", { name: "戦績", exact: true });
  for (const label of ["対局数", "優勝数", "2位数", "3位数", "4位数"])
    await metric(section, label, "0");
  for (const label of ["優勝率", "2位率", "3位率", "4位率"]) await metric(section, label, ".000");
  await section.getByRole("tab", { name: "ダブルス" }).click();
  for (const label of ["対局数", "勝数", "敗数"]) await metric(section, label, "0");
  for (const label of ["勝率", "敗率"]) await metric(section, label, ".000");
});

test("読み込み中や取得失敗を0件にせず、再試行・更新し、更新失敗時は取得済みの値を保つ", async ({
  page,
}) => {
  await mockAccount(page, profile);
  let release = () => {};
  let held = true;
  let failed = true;
  let result = sample;
  await page.route("**/api/account/stats", async (route) => {
    if (held)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill(failed ? { status: 503, json: { message: "取得失敗" } } : { json: result });
  });
  await page.goto("/account");
  const section = page.getByRole("region", { name: "戦績", exact: true });
  const refresh = section.getByRole("button", { name: "更新", exact: true });
  await expect(section.getByRole("status")).toHaveText("戦績を読み込んでいます…");
  await expect(refresh).toBeDisabled();
  await expect(section.getByText("対局数", { exact: true })).toHaveCount(0);
  await section.getByRole("tab", { name: "ダブルス" }).click();
  await expect(section.getByRole("status")).toBeVisible();
  held = false;
  release();
  await expect(section.getByRole("alert")).toHaveText("戦績を取得できませんでした。");
  await expect(section.getByText("対局数", { exact: true })).toHaveCount(0);
  failed = false;
  await section.getByRole("button", { name: "再試行" }).click();
  await metric(section, "対局数", "6");
  await expect(section.getByRole("alert")).toHaveCount(0);
  held = true;
  failed = true;
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(section.getByRole("status")).toBeVisible();
  await metric(section, "勝数", "3");
  held = false;
  release();
  await expect(section.getByRole("alert")).toBeVisible();
  await metric(section, "対局数", "6");
  failed = false;
  result = {
    ...sample,
    singles: { total: 1, first: 1, second: 0, third: 0, fourth: 0 },
    doubles: { total: 1, wins: 1, losses: 0, draws: 0 },
  };
  await section.getByRole("button", { name: "再試行" }).click();
  await metric(section, "対局数", "1");
  await metric(section, "勝率", "1.000");
  await section.getByRole("tab", { name: "シングルス" }).click();
  await metric(section, "対局数", "1");
  await metric(section, "優勝率", "1.000");
});

test("不正な集計応答も取得失敗として表示する", async ({ page }) => {
  await mockAccount(page, profile);
  await page.route("**/api/account/stats", (route) =>
    route.fulfill({ json: { ...sample, doubles: { total: 6, wins: 6, losses: 2, draws: 1 } } }),
  );
  await page.goto("/account");
  const section = page.getByRole("region", { name: "戦績", exact: true });
  await expect(section.getByRole("alert")).toHaveText("戦績を取得できませんでした。");
  await expect(section.getByText("対局数", { exact: true })).toHaveCount(0);
});
