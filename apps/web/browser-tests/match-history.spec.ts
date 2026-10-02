import { expect, test, type Page, type Route } from "@playwright/test";
import { type MatchSummary } from "@tetraboard/protocol";
import { mockAccount, profile } from "./accountFixtures";

function match(index: number, mode: "singles" | "doubles" = "singles"): MatchSummary {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id,
    game: "four-reversi",
    mode,
    startedAtMs: Date.UTC(2026, 9, 2, 6, 30) - index * 60000,
    endedAtMs: Date.UTC(2026, 9, 2, 7, 30),
    participants: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "あいうえおかきくけこ",
        color: "black",
        seat: 0,
        kind: "human",
        avatarUrl: null,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "さしすせそたちつてと",
        color: "white",
        seat: 1,
        kind: "human",
        avatarUrl: null,
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "CPU Lv1",
        color: "red",
        seat: 2,
        kind: "cpu",
        level: 1,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "CPU Lv2",
        color: "blue",
        seat: 3,
        kind: "cpu",
        level: 2,
      },
    ],
    result:
      mode === "singles"
        ? {
            mode,
            reason: "board_full",
            standings: [
              { color: "black", rank: 1, stoneCount: 20 },
              { color: "white", rank: 1, stoneCount: 20 },
              { color: "red", rank: 3, stoneCount: 15 },
              { color: "blue", rank: 4, stoneCount: 9 },
            ],
          }
        : {
            mode,
            reason: "board_full",
            winner: index % 2 === 0 ? "white-blue" : null,
            teamTotals: { "black-red": 32, "white-blue": 32 },
            stoneCounts: [
              { color: "black", count: 16 },
              { color: "white", count: 16 },
              { color: "red", count: 16 },
              { color: "blue", count: 16 },
            ],
          },
  };
}
async function mockHistory(page: Page) {
  await mockAccount(page, profile);
  let failure: "initial" | "more" | null = null;
  let held: Route | null = null;
  let holdMode: "singles" | "doubles" | null = null;
  let heldResolve: (() => void) | null = null;
  const captured = () =>
    new Promise<void>((resolve) => {
      heldResolve = resolve;
    });
  async function respond(route: Route) {
    const url = new URL(route.request().url());
    const mode = url.searchParams.get("mode") as "singles" | "doubles";
    const more = url.searchParams.has("cursor");
    if (failure === (more ? "more" : "initial"))
      return route.fulfill({ status: 503, json: { message: "取得失敗" } });
    return route.fulfill({
      json: {
        matches:
          mode === "singles"
            ? Array.from({ length: more ? 1 : 20 }, (_, i) => match(more ? 21 : i + 1))
            : [match(1, "doubles"), match(2, "doubles")],
        nextCursor: mode === "singles" && !more ? `${match(20).startedAtMs}:${match(20).id}` : null,
      },
    });
  }
  await page.route("**/api/account/matches?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("mode") === holdMode) {
      held = route;
      heldResolve?.();
      return;
    }
    await respond(route);
  });
  return {
    fail: (type: "initial" | "more" | null) => {
      failure = type;
    },
    hold: (mode: "singles" | "doubles") => {
      holdMode = mode;
      return captured();
    },
    release: async () => {
      holdMode = null;
      if (held) {
        await respond(held);
        held = null;
      }
    },
  };
}

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`棋譜カードと順位・チームを${width}pxでコンパクトに表示する`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await mockHistory(page);
    await page.goto("/account");
    const card = page.getByTestId("account-replay-card");
    await expect(card.getByRole("tab", { name: "シングルス" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(card.getByRole("article")).toHaveCount(20);
    const first = card.getByRole("article").first();
    await expect(first).toHaveAccessibleName("2026/10/02 15:29 四人リバーシ・シングルスの対局");
    await expect(first.getByText("四人リバーシ・シングルス", { exact: true })).toBeVisible();
    await expect(first.getByText("2026/10/02 15:29", { exact: true })).toBeVisible();
    await expect(first.getByText("優勝", { exact: true })).toHaveCount(2);
    await expect(first.getByText("2位", { exact: true })).toHaveCount(0);
    await expect(first.getByText("3位", { exact: true })).toBeVisible();
    await expect(first.getByRole("button", { name: "棋譜を見る", exact: true })).toBeDisabled();
    await expect(first.getByText("準備中", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const name of ["あいうえおかきくけこ", "さしすせそたちつてと"]) {
      const label = first.getByText(name, { exact: true });
      await expect(label).toBeVisible();
      expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await info.attach(`history-singles-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await card.getByRole("tab", { name: "ダブルス" }).click();
    await expect(card.getByRole("article")).toHaveCount(2);
    await expect(
      card.getByRole("article").first().getByText("引き分け", { exact: true }),
    ).toHaveCount(2);
    const win = card.getByRole("article").nth(1);
    await expect(win.getByText("勝利", { exact: true })).toBeVisible();
    await expect(win.getByText("敗北", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await info.attach(`history-doubles-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
}

test("失敗時の再試行・追加読み込み・タブ保持・更新と遅延応答を操作できる", async ({ page }) => {
  const fixture = await mockHistory(page);
  fixture.fail("initial");
  await page.goto("/account");
  const card = page.getByTestId("account-replay-card");
  await expect(card.getByRole("alert")).toHaveText("対局履歴を取得できませんでした。");
  fixture.fail(null);
  await card.getByRole("button", { name: "再試行", exact: true }).click();
  await expect(card.getByRole("article")).toHaveCount(20);
  fixture.fail("more");
  await card.getByRole("button", { name: "もっと見る", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("続きの対局履歴を取得できませんでした。");
  await expect(card.getByRole("article")).toHaveCount(20);
  fixture.fail(null);
  await card.getByRole("button", { name: "再試行", exact: true }).click();
  await expect(card.getByRole("article")).toHaveCount(21);
  await expect(card.getByRole("button", { name: "もっと見る", exact: true })).toHaveCount(0);
  const held = fixture.hold("doubles");
  await card.getByRole("tab", { name: "ダブルス" }).click();
  await held;
  await expect(card.getByRole("status")).toContainText("読み込んでいます");
  await card.getByRole("tab", { name: "シングルス" }).click();
  await expect(card.getByRole("article")).toHaveCount(21);
  await fixture.release();
  await expect(card.getByRole("article")).toHaveCount(21);
  await card.getByRole("tab", { name: "ダブルス" }).click();
  await expect(card.getByRole("article")).toHaveCount(2);
  await card.getByRole("tab", { name: "シングルス" }).click();
  const heldRefresh = fixture.hold("singles");
  await card.getByRole("button", { name: "更新", exact: true }).click();
  await heldRefresh;
  await expect(card.getByRole("button", { name: "更新", exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: "もっと見る", exact: true })).toHaveCount(0);
  await fixture.release();
  await expect(card.getByRole("article")).toHaveCount(20);
});

test("両タブの空履歴とキーボード操作を表示する", async ({ page }) => {
  await mockAccount(page, profile);
  await page.goto("/account");
  const card = page.getByTestId("account-replay-card");
  await expect(card.getByText("まだ対局履歴がありません。", { exact: true })).toBeVisible();
  await card.getByRole("tab", { name: "シングルス" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(card.getByRole("tab", { name: "ダブルス" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(card.getByText("まだ対局履歴がありません。", { exact: true })).toBeVisible();
});
