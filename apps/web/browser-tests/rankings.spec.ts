import { expect, test, type Page } from "@playwright/test";
import { type FourReversiRankings, type RankingEntry } from "@tetraboard/protocol";
import { mockLobby } from "./fixtures";

const path = "**/api/games/four-reversi/rankings";
const list = (prefix: string): RankingEntry[] =>
  Array.from({ length: 10 }, (_, index) => ({
    rank: index < 2 ? 1 : 3,
    username: `${prefix}_${index}`,
    name: index === 0 ? "あいうえおかきくけこ" : `${prefix}${index + 1}`,
    avatarUrl: index === 0 ? "/api/avatars/00000000-0000-4000-8000-000000000001" : null,
    value: index < 2 ? 12 : 8,
  }));
const data: FourReversiRankings = {
  singles: { first: list("優勝"), total: list("単局") },
  doubles: { wins: list("勝利"), total: list("複局") },
};
// 公開IDはASCIIで固定し、表示名だけを日本語にします。
for (const [mode, groups] of Object.entries(data))
  for (const [metric, entries] of Object.entries(groups))
    entries.forEach((entry, index) => {
      entry.username = `${mode}_${metric}_${index}`;
    });

async function setup(page: Page) {
  await mockLobby(page);
  await page.route(path, (route) => route.fulfill({ json: data }));
  await page.route("**/api/avatars/*", (route) => route.fulfill({ status: 404 }));
  await page.goto("/games/four-reversi");
}

for (const width of [320, 390, 767, 768, 1024, 1440]) {
  test(`ロビーの盤面・等幅配置・上位3人と詳細10人 ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    const play = page.getByRole("region", { name: "一人で遊ぶ", exact: true });
    const ranking = page.getByRole("region", { name: "ランキング", exact: true });
    const rows = ranking.getByRole("list", { name: "優勝数ランキング" }).getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("1位");
    await expect(rows.nth(1)).toContainText("1位");
    await expect(rows.nth(2)).toContainText("3位");
    await expect(rows.nth(0)).toContainText("あいうえおかきくけこ");
    await expect(rows.nth(0).locator("svg")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const left = (await play.boundingBox())!;
    const right = (await ranking.boundingBox())!;
    if (width >= 768) {
      expect(Math.abs(left.width - right.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
      expect(right.x).toBeGreaterThan(left.x + left.width);
    } else {
      expect(Math.abs(left.x - right.x)).toBeLessThanOrEqual(1);
      expect(right.y).toBeGreaterThan(left.y + left.height);
    }
    const buttons = play.getByRole("button");
    await expect(buttons).toHaveText(["すぐ遊ぶ", "ルームを作る", "ルーム番号で参加"]);
    const bounds = await buttons.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().y),
    );
    expect(bounds[1]).toBeGreaterThan(bounds[0]);
    expect(bounds[2]).toBeGreaterThan(bounds[1]);
    const title = page.getByRole("heading", { name: "四人リバーシ", exact: true });
    const preview = title.locator("../..").locator('[aria-hidden="true"]');
    await expect(preview).toBeVisible();
    const board = (await preview.boundingBox())!;
    const heading = (await title.boundingBox())!;
    expect(board.x + board.width).toBeLessThan(heading.x);
    await expect(page.getByText("CPU3人と対戦", { exact: true })).toHaveCount(0);
    await expect(page.getByText("友達と遊ぶ", { exact: true })).toHaveCount(0);
    await testInfo.attach("lobby-rankings", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    await ranking.getByRole("tab", { name: "ダブルス", exact: true }).click();
    await expect(
      ranking.getByRole("list", { name: "勝利数ランキング" }).getByRole("listitem"),
    ).toHaveCount(3);
    const trigger = ranking.getByRole("button", { name: "もっと見る" });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      dialog.getByRole("list", { name: "勝利数ランキング" }).getByRole("listitem"),
    ).toHaveCount(10);
    await dialog.getByRole("tab", { name: "対局数", exact: true }).click();
    await expect(dialog.getByRole("list", { name: "対局数ランキング" })).toContainText("複局2");
    await dialog.getByRole("tab", { name: "シングルス", exact: true }).click();
    await expect(dialog.getByRole("list", { name: "対局数ランキング" })).toContainText("単局2");
    await dialog.getByRole("tab", { name: "優勝数", exact: true }).click();
    await expect(
      dialog.getByRole("list", { name: "優勝数ランキング" }).getByRole("listitem"),
    ).toHaveCount(10);
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press("Tab");
      await expect
        .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await testInfo.attach("rankings-dialog", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(ranking.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
}

test("初回の読み込み・失敗・再試行と空一覧を区別する", async ({ page }) => {
  await mockLobby(page);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route(path, async (route) => {
    await pending;
    await route.fulfill({ status: 503, json: { message: "failed" } });
  });
  await page.goto("/games/four-reversi");
  const ranking = page.getByRole("region", { name: "ランキング", exact: true });
  await expect(ranking.getByRole("status")).toContainText("読み込んでいます");
  await expect(ranking.getByText("まだランキングの対象者がいません。")).toHaveCount(0);
  finish();
  await expect(ranking.getByRole("alert")).toBeVisible();
  await page.route(path, (route) =>
    route.fulfill({
      json: { singles: { first: [], total: [] }, doubles: { wins: [], total: [] } },
    }),
  );
  await ranking.getByRole("button", { name: "再試行" }).click();
  await expect(ranking.getByText("まだランキングの対象者がいません。")).toBeVisible();
  await expect(ranking.getByRole("alert")).toHaveCount(0);
});

test("更新失敗でも一覧を保持し、再取得で最新プロフィールを反映する", async ({ page }) => {
  await setup(page);
  const ranking = page.getByRole("region", { name: "ランキング", exact: true });
  await expect(ranking.getByRole("listitem")).toHaveCount(3);
  await page.route(path, (route) => route.fulfill({ status: 503, json: {} }));
  await ranking.getByRole("button", { name: "ランキングを更新" }).click();
  await expect(ranking.getByRole("alert")).toBeVisible();
  await expect(ranking.getByRole("listitem")).toHaveCount(3);
  const updated = structuredClone(data);
  updated.singles.first[0].name = "最新の名前";
  updated.singles.first[0].avatarUrl = null;
  await page.route(path, (route) => route.fulfill({ json: updated }));
  await ranking.getByRole("button", { name: "再試行" }).click();
  await expect(ranking.getByRole("listitem").first()).toContainText("最新の名前");
  await expect(ranking.getByRole("alert")).toHaveCount(0);
});

test("遅延した取得中でもモードを切り替え、閉じた詳細から更新を続けられる", async ({ page }) => {
  await setup(page);
  const ranking = page.getByRole("region", { name: "ランキング", exact: true });
  await expect(ranking.getByRole("listitem")).toHaveCount(3);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const updated = structuredClone(data);
  updated.doubles.wins[0].name = "新しい勝者";
  await page.route(path, async (route) => {
    await pending;
    await route.fulfill({ json: updated });
  });
  await ranking.getByRole("button", { name: "もっと見る" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "更新", exact: true }).click();
  await expect(dialog.getByRole("status")).toBeVisible();
  await dialog.getByRole("tab", { name: "ダブルス", exact: true }).click();
  await page.keyboard.press("Escape");
  await ranking.getByRole("tab", { name: "ダブルス", exact: true }).click();
  finish();
  await expect(ranking.getByRole("listitem").first()).toContainText("新しい勝者");
  await expect(ranking.getByRole("status")).toHaveCount(0);
});
