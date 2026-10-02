import { expect, test, type Page } from "@playwright/test";
import { type FourShogiRankings, type RankingEntry } from "@tetraboard/protocol";
import { mockLobby } from "./fixtures";

const list = (prefix: string, display: string): RankingEntry[] =>
  Array.from({ length: 10 }, (_, index) => ({
    rank: index < 2 ? 1 : index + 1,
    username: `${prefix}_${index}`,
    name: index === 0 ? "あいうえおかきくけこ" : `${display}${index + 1}`,
    avatarUrl: index === 0 ? "/api/avatars/00000000-0000-4000-8000-000000000001" : null,
    value: index < 2 ? 12 : 10 - index,
  }));
const data: FourShogiRankings = {
  singles: { first: list("singlewins", "優勝"), total: list("singlematches", "単局") },
  doubles: { wins: list("teamwins", "勝利"), total: list("teammatches", "複局") },
};
async function setup(page: Page) {
  await mockLobby(page);
  const requested: string[] = [];
  let failure = false;
  let hold = false;
  let release: (() => void) | null = null;
  await page.route("**/api/games/four-shogi/rankings", async (route) => {
    requested.push(new URL(route.request().url()).pathname);
    if (hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill(failure ? { status: 503, json: { message: "取得不可" } } : { json: data });
  });
  await page.route("**/api/games/four-reversi/rankings", async (route) => {
    requested.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 503, json: { message: "将棋から呼ぶべきではない" } });
  });
  await page.route("**/api/avatars/*", (route) => route.fulfill({ status: 404 }));
  return {
    requested,
    fail: () => {
      failure = true;
    },
    succeed: () => {
      failure = false;
    },
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      release?.();
    },
  };
}

for (const width of [320, 390, 767, 768, 1024, 1440]) {
  test(`${width}pxで将棋専用ランキングの3人と詳細10人を黄色テーマで表示する`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await setup(page);
    await page.goto("/games/four-shogi");
    const ranking = page.getByRole("region", { name: "ランキング", exact: true });
    const rows = ranking
      .getByRole("list", { name: "優勝数ランキング", exact: true })
      .getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("1位");
    await expect(rows.nth(1)).toContainText("1位");
    await expect(rows.nth(2)).toContainText("3位");
    await expect(rows.nth(0)).toContainText("あいうえおかきくけこ");
    await expect(rows.nth(0).locator("svg")).toBeVisible();
    await expect(ranking).not.toContainText("準備中");
    await expect(ranking).not.toContainText("撃破数");
    await expect(page.getByRole("button", { name: /^すぐ遊ぶ/ })).toHaveCSS(
      "background-color",
      "rgb(242, 188, 59)",
    );
    await ranking.getByRole("tab", { name: "ダブルス", exact: true }).click();
    await expect(
      ranking.getByRole("list", { name: "勝利数ランキング", exact: true }).getByRole("listitem"),
    ).toHaveCount(3);
    await ranking.getByRole("button", { name: "もっと見る", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "ランキング", exact: true });
    await expect(dialog.getByRole("listitem")).toHaveCount(10);
    await expect(dialog.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await dialog.getByRole("tab", { name: "対局数", exact: true }).click();
    await expect(dialog.getByRole("listitem").nth(1)).toContainText("複局2");
    await dialog.getByRole("tab", { name: "シングルス", exact: true }).click();
    await expect(dialog.getByRole("listitem").nth(1)).toContainText("単局2");
    await dialog.getByRole("tab", { name: "優勝数", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "優勝数", exact: true })).toHaveCSS(
      "color",
      "rgb(117, 101, 74)",
    );
    await expect(dialog.getByRole("listitem").nth(1)).toContainText("優勝2");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(ranking.getByRole("button", { name: "もっと見る", exact: true })).toBeFocused();
    await expect(ranking.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(api.requested).toEqual(["/api/games/four-shogi/rankings"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await info.attach("将棋ランキング", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
}

test("将棋ランキングの更新中に切り替えでき、失敗時は取得済みの人数と値を保持する", async ({
  page,
}) => {
  const api = await setup(page);
  await page.goto("/games/four-shogi");
  const ranking = page.getByRole("region", { name: "ランキング", exact: true });
  await expect(ranking.getByRole("listitem")).toHaveCount(3);
  api.hold();
  await ranking.getByRole("button", { name: "ランキングを更新", exact: true }).click();
  await expect(ranking.getByRole("status")).toBeVisible();
  await ranking.getByRole("tab", { name: "ダブルス", exact: true }).click();
  await expect(ranking.getByRole("listitem").nth(1)).toContainText("勝利2");
  await ranking.getByRole("button", { name: "もっと見る", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "ランキング", exact: true });
  await dialog.getByRole("tab", { name: "対局数", exact: true }).click();
  await expect(dialog.getByRole("listitem")).toHaveCount(10);
  api.fail();
  api.release();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("listitem").nth(1)).toContainText("複局2");
  api.succeed();
  await dialog.getByRole("button", { name: "再試行", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("listitem")).toHaveCount(10);
});
