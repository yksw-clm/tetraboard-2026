import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { type AccountStats, type MatchSummary, type RoomMode } from "@tetraboard/protocol";
import { mockAccount, profile } from "./accountFixtures";
import { shogiReplayMatch, shogiStats } from "./fourShogiRecordFixtures";
import { replayMatch } from "./matchReplayFixtures";

const reversiStats: AccountStats = {
  singles: { total: 12, first: 4, second: 2, third: 6, fourth: 0 },
  doubles: { total: 6, wins: 3, losses: 2, draws: 1 },
};
async function chooseGame(page: Page, label: string, name: string) {
  await page.getByRole("button", { name: new RegExp(`${label}$`) }).click();
  await expect(page.getByRole("option")).toHaveText(["四人リバーシ", "四人将棋"]);
  await page.getByRole("option", { name, exact: true }).click();
}
async function metric(section: Locator, label: string, value: string) {
  await expect(section.getByText(label, { exact: true }).locator("..").locator("dd")).toHaveText(
    value,
  );
}
async function setup(page: Page) {
  await mockAccount(page, profile);
  const requests: string[] = [];
  let fail = false;
  let hold = false;
  const held: { route: Route; json: unknown }[] = [];
  const histories = new Map<string, MatchSummary[]>();
  for (const mode of ["singles", "doubles"] as const) {
    const rev = replayMatch(mode);
    histories.set(`four-reversi:${mode}`, [
      {
        id: rev.id,
        game: "four-reversi",
        mode,
        startedAtMs: rev.startedAtMs,
        endedAtMs: rev.endedAtMs,
        participants: rev.participants,
        result: rev.game.result,
      },
    ]);
    histories.set(`four-shogi:${mode}`, [shogiReplayMatch(mode).summary]);
  }
  async function respond(route: Route, json: unknown, game: string) {
    if (fail && game === "four-shogi")
      return route.fulfill({ status: 503, json: { message: "取得不可" } });
    if (hold && game === "four-shogi") {
      held.push({ route, json });
      return;
    }
    await route.fulfill({ json });
  }
  await page.route(/\/api\/account\/stats(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const game = url.searchParams.get("game") ?? "four-reversi";
    return respond(route, game === "four-shogi" ? shogiStats : reversiStats, game);
  });
  await page.route("**/api/account/matches?**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const game = url.searchParams.get("game") ?? "four-reversi";
    const mode = url.searchParams.get("mode") as RoomMode;
    return respond(route, { matches: histories.get(`${game}:${mode}`), nextCursor: null }, game);
  });
  return {
    requests,
    fail: () => {
      fail = true;
    },
    hold: () => {
      hold = true;
    },
    release: async () => {
      hold = false;
      for (const { route, json } of held.splice(0)) await route.fulfill({ json }).catch(() => {});
    },
  };
}

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`${width}pxで全幅のゲームSelectと独立した戦績・棋譜の4組を表示する`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const api = await setup(page);
    await page.goto("/account");
    const stats = page.getByRole("region", { name: "戦績", exact: true });
    const history = page.getByTestId("account-replay-card");
    await metric(stats, "対局数", "12");
    await expect(history.getByRole("article")).toContainText("四人リバーシ・シングルス");
    for (const [section, title, label] of [
      [stats, "戦績", "戦績のゲーム"],
      [history, "棋譜", "棋譜のゲーム"],
    ] as const) {
      const heading = await section
        .getByRole("heading", { name: title, exact: true })
        .boundingBox();
      const select = await section
        .getByRole("button", { name: new RegExp(`${label}$`) })
        .boundingBox();
      const tabs = await section.getByRole("tablist").boundingBox();
      expect(select!.y).toBeGreaterThan(heading!.y + heading!.height);
      expect(tabs!.y).toBeGreaterThan(select!.y + select!.height);
      expect(select!.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(select!.width - tabs!.width)).toBeLessThanOrEqual(2);
    }
    await stats.getByRole("tab", { name: "ダブルス", exact: true }).click();
    await metric(stats, "対局数", "6");
    await chooseGame(page, "戦績のゲーム", "四人将棋");
    await metric(stats, "撃破数", "11");
    await metric(stats, "優勝率", ".250");
    await expect(history.getByRole("article")).toContainText("四人リバーシ・シングルス");
    await chooseGame(page, "棋譜のゲーム", "四人将棋");
    await expect(history.getByRole("article")).toContainText("四人将棋・シングルス");
    await expect(history.getByRole("listitem")).toHaveText([
      /優勝.*さしすせそたちつてと/,
      /2位.*CPU Lv1/,
      /3位.*CPU Lv2/,
      /4位.*あいうえおかきくけこ/,
    ]);
    await history.getByRole("tab", { name: "ダブルス", exact: true }).click();
    await expect(history.getByRole("article")).toContainText("四人将棋・ダブルス");
    await expect(history.getByRole("article")).toContainText("勝利");
    await metric(stats, "撃破数", "11");
    await stats.getByRole("tab", { name: "ダブルス", exact: true }).click();
    await metric(stats, "対局数", "5");
    await metric(stats, "勝率", ".200");
    await metric(stats, "敗率", ".600");
    await expect(stats.getByText("撃破数", { exact: true })).toHaveCount(0);
    await chooseGame(page, "戦績のゲーム", "四人リバーシ");
    await metric(stats, "対局数", "6");
    await chooseGame(page, "棋譜のゲーム", "四人リバーシ");
    await expect(history.getByRole("article")).toContainText("四人リバーシ・シングルス");
    await history.getByRole("tab", { name: "ダブルス", exact: true }).click();
    await expect(history.getByRole("article")).toContainText("四人リバーシ・ダブルス");
    await chooseGame(page, "棋譜のゲーム", "四人将棋");
    await expect(history.getByRole("article")).toContainText("四人将棋・ダブルス");
    expect(api.requests).toContain("/api/account/stats");
    expect(api.requests).toContain("/api/account/stats?game=four-shogi");
    expect(api.requests.filter((request) => request.includes("game=four-reversi"))).toEqual([]);
    await expect(page.getByRole("banner").getByText("Board", { exact: true })).toHaveCSS(
      "color",
      "rgb(39, 132, 85)",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await info.attach("ゲーム別戦績と棋譜", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
}

test("将棋の遅延応答は別ゲームへ混ざらず、更新失敗時にも取得済み値を保持する", async ({ page }) => {
  const api = await setup(page);
  await page.goto("/account");
  const stats = page.getByRole("region", { name: "戦績", exact: true });
  const history = page.getByTestId("account-replay-card");
  await metric(stats, "対局数", "12");
  api.hold();
  await chooseGame(page, "戦績のゲーム", "四人将棋");
  await expect(stats.getByRole("status")).toContainText("戦績を読み込んでいます");
  await chooseGame(page, "棋譜のゲーム", "四人将棋");
  await expect(history.getByRole("status")).toContainText("対局履歴を読み込んでいます");
  await expect
    .poll(() => api.requests.filter((request) => request.includes("game=four-shogi")).length)
    .toBe(2);
  await chooseGame(page, "戦績のゲーム", "四人リバーシ");
  await chooseGame(page, "棋譜のゲーム", "四人リバーシ");
  await api.release();
  await metric(stats, "対局数", "12");
  await expect(stats.getByText("撃破数", { exact: true })).toHaveCount(0);
  await expect(history.getByRole("article")).toContainText("四人リバーシ・シングルス");
  await chooseGame(page, "戦績のゲーム", "四人将棋");
  await chooseGame(page, "棋譜のゲーム", "四人将棋");
  await metric(stats, "撃破数", "11");
  await expect(history.getByRole("article")).toContainText("四人将棋・シングルス");
  api.fail();
  await stats.getByRole("button", { name: "更新", exact: true }).click();
  await expect(stats.getByRole("alert")).toBeVisible();
  await metric(stats, "撃破数", "11");
  await history.getByRole("button", { name: "更新", exact: true }).click();
  await expect(history.getByRole("alert")).toBeVisible();
  await expect(history.getByRole("article")).toContainText("四人将棋・シングルス");
});
