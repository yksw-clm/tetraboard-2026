import { expect, test } from "@playwright/test";
import { mockLobby } from "./fixtures";
import { mockAccount, profile } from "./accountFixtures";
import { gameIds, gameCatalog } from "@tetraboard/protocol/games";
import { publicPages, publicOrigin } from "../src/publicPages/catalog";

test("ゲーム切替と履歴移動でタイトル・正規URLが追従し、ルールから遊び始められる", async ({
  page,
}) => {
  await mockLobby(page);
  await page.goto("/games/four-reversi?source=seo");
  await expect(page).toHaveTitle(publicPages["four-reversi"].lobby.title);
  const canonical = page.locator('link[rel="canonical"]');
  await expect(canonical).toHaveAttribute("href", `${publicOrigin}/games/four-reversi`);
  await page
    .getByRole("navigation", { name: "ゲームを選択" })
    .getByRole("link", { name: "四人将棋" })
    .click();
  await expect(page).toHaveTitle(publicPages["four-shogi"].lobby.title);
  await expect(canonical).toHaveAttribute("href", `${publicOrigin}/games/four-shogi`);
  await page.goBack();
  await expect(page).toHaveTitle(publicPages["four-reversi"].lobby.title);
  await page.goForward();
  await expect(page).toHaveTitle(publicPages["four-shogi"].lobby.title);
  await page.getByRole("link", { name: "四人将棋のルール・遊び方", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("四人将棋のルール・遊び方");
  await expect(page).toHaveTitle(publicPages["four-shogi"].rules.title);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "ルールの目次" })).toBeVisible();
  await page.getByRole("navigation", { name: "ルールの目次" }).getByRole("link").last().click();
  await expect(page).toHaveURL(/#rule-\d+$/);
  await page.getByRole("link", { name: "四人将棋を遊ぶ", exact: true }).last().click();
  await expect(page.getByRole("button", { name: /^すぐ遊ぶ/ })).toBeVisible();
  await page.getByRole("button", { name: /^すぐ遊ぶ/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

for (const game of gameIds) {
  test(`${game}: JavaScriptなしでも公開本文とルール・目次を読める`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    const page = await context.newPage();
    try {
      await page.goto(publicPages[game].lobby.path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(gameCatalog[game].name);
      await expect(
        page.getByText("アプリのインストールやユーザー登録なし", { exact: false }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: `${gameCatalog[game].name}のルール・遊び方`, exact: true })
        .click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        `${gameCatalog[game].name}のルール・遊び方`,
      );
      await expect(
        page.getByRole("heading", { name: "投了、通信切れと持ち時間", exact: true }),
      ).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index,follow");
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
        "content",
        publicOrigin + publicPages[game].rules.path,
      );
    } finally {
      await context.close();
    }
  });
}

test("320pxのルールを読め、プロフィール未完了でもルールを表示する", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await mockAccount(page, { ...profile, profileCompleted: false });
  await page.goto("/games/four-shogi/rules");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("四人将棋のルール・遊び方");
  await expect(page.getByRole("navigation", { name: "ルールの目次" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto("/login");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex,follow");
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
});
