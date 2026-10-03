import { expect, test, type Page } from "@playwright/test";
import { mockAccount, profile } from "./accountFixtures";
import { shogiReplayMatch } from "./fourShogiRecordFixtures";

async function chooseGame(page: Page, label: string, name: string) {
  await page.getByRole("button", { name: new RegExp(`${label}$`) }).click();
  await page.getByRole("option", { name, exact: true }).click();
}
async function selectFrame(page: Page, label: string) {
  await page.getByRole("button", { name: /棋譜の局面$/ }).click();
  await page.getByRole("option", { name: new RegExp(`${label}$`) }).click();
}
async function setup(page: Page, fixture = shogiReplayMatch()) {
  await mockAccount(page, profile);
  const cursors: number[] = [];
  const online: string[] = [];
  const sockets: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/rooms(?:\/|\?|$)/.test(request.url())) online.push(request.url());
  });
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.includes("/api/rooms/")) sockets.push(socket.url());
  });
  await page.route("**/api/account/matches?**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: {
        matches:
          query.get("game") === "four-shogi" && query.get("mode") === fixture.detail.settings.mode
            ? [fixture.summary]
            : [],
        nextCursor: null,
      },
    });
  });
  await page.route(/\/api\/account\/matches\/[^/?]+$/, (route) =>
    route.fulfill({ json: { match: fixture.detail } }),
  );
  await page.route(/\/api\/account\/matches\/[^/?]+\/replay(?:\?.*)?$/, (route) => {
    const cursor = Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0);
    cursors.push(cursor);
    return route.fulfill({ json: fixture.page(cursor) });
  });
  return { cursors, online, sockets };
}

for (const width of [320, 390, 768, 1279, 1280, 1440]) {
  test(`${width}pxで保存将棋棋譜を本人の向きで閲覧し、持ち駒・成り・裏王を表示する`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 950 });
    const fixture = shogiReplayMatch();
    const traffic = await setup(page, fixture);
    await page.goto("/account");
    await chooseGame(page, "棋譜のゲーム", "四人将棋");
    await page.getByRole("link", { name: "棋譜を見る", exact: true }).click();
    await expect(page).toHaveURL(`/account/matches/${fixture.detail.id}`);
    await expect(page.getByText("対局終了", { exact: true })).toBeVisible();
    const board = page.getByRole("group", { name: "四人将棋の盤面", exact: true });
    await expect(board.getByRole("button")).toHaveCount(81);
    for (const cell of await board.getByRole("button").all()) await expect(cell).toBeDisabled();
    await expect(board.locator("[data-legal-destination]")).toHaveCount(0);
    await expect(board.getByRole("button", { name: /裏王/ })).toHaveCount(3);
    const self = page
      .getByTestId("player-card")
      .filter({ hasText: fixture.detail.participants[0]!.name });
    expect(await self.evaluate((element) => getComputedStyle(element).gridArea)).toBe("bottom");
    await expect(self.getByText("1位", { exact: true })).toBeVisible();
    await expect(page.getByText("4位（退室）", { exact: true })).toBeVisible();
    const hand = page.getByRole("group", { name: "北の持ち駒", exact: true });
    for (const kind of ["飛車", "金", "銀"])
      await expect(
        hand.getByRole("button", { name: `北の持ち駒、${kind}1枚`, exact: true }),
      ).toBeDisabled();
    await expect(page.getByRole("button", { name: "棋譜を1つ進む", exact: true })).toBeDisabled();
    await selectFrame(page, "開始局面");
    await expect(board.getByRole("button", { name: /裏王/ })).toHaveCount(0);
    await expect(page.getByTestId("player-card").getByText(/位（/)).toHaveCount(0);
    await expect(hand.getByRole("button")).toHaveCount(0);
    await expect(board.locator("[data-last-move]")).toHaveCount(0);
    await expect(board.locator('[data-square="E1"] [data-piece-direction="up"]')).toBeVisible();
    await expect(board.locator('[data-square="E9"] [data-piece-direction="down"]')).toBeVisible();
    const northKing = (await board.locator('[data-square="E1"]').boundingBox())!;
    const southKing = (await board.locator('[data-square="E9"]').boundingBox())!;
    expect(northKing.y).toBeGreaterThan(southKing.y);
    await selectFrame(page, "62: 東B3飛成");
    await expect(board.getByRole("button", { name: /B3：東の龍/ })).toBeVisible();
    await expect(board.locator('[data-square="B3"]')).toHaveAttribute("data-last-move", "to");
    await expect(board.locator('[data-square="C3"]')).toHaveAttribute("data-last-move", "from");
    await expect(
      hand.getByRole("button", { name: "北の持ち駒、銀1枚", exact: true }),
    ).toBeDisabled();
    await selectFrame(page, "30: 西C7歩打");
    await expect(board.getByRole("button", { name: /C7：西の歩/ })).toHaveAttribute(
      "data-last-move",
      "to",
    );
    await selectFrame(page, "西 退室 / 脱落：西4位（退室）");
    await expect(board.getByRole("button", { name: /裏王/ })).toHaveCount(1);
    await expect(page.getByText("4位（退室）", { exact: true })).toBeVisible();
    await expect(page.getByText("3位（時間切れ）", { exact: true })).toHaveCount(0);
    if (width < 1280) {
      await expect(page.getByRole("tab", { name: "チャット", exact: true })).toHaveCount(0);
      await page.getByRole("tab", { name: "ルーム", exact: true }).click();
    }
    await expect(page.getByText("棋譜を閲覧中です。", { exact: true })).toBeVisible();
    for (const name of [
      "準備完了",
      "対局開始",
      "参加する",
      "投了",
      "退室",
      "招待リンクをコピー",
      "CPUを追加",
    ])
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(page.getByLabel(/接続中|切断中/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "結果", exact: true })).toHaveCSS(
      "background-color",
      "rgb(255, 240, 201)",
    );
    await page.getByRole("button", { name: "結果", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "対局結果", exact: true })).toContainText("南");
    await page.getByRole("dialog").getByRole("button", { name: "閉じる", exact: true }).click();
    expect(traffic.cursors).toEqual([0, 100]);
    await page.reload();
    await expect(page.getByText("3位（時間切れ）", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "棋譜を1つ進む", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await info.attach("保存された将棋棋譜", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expect(traffic.online).toEqual([]);
    expect(traffic.sockets).toEqual([]);
  });
}

test("低いスマホ画面でも保存棋譜の盤・持ち駒・4席をスクロールなしで閲覧する", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 522, height: 773 });
  const fixture = shogiReplayMatch();
  await setup(page, fixture);
  await page.goto(`/account/matches/${fixture.detail.id}`);
  const board = page.getByTestId("shogi-board");
  await expect(page.getByText("対局終了", { exact: true })).toBeVisible();
  for (const height of [773, 480]) {
    await page.setViewportSize({ width: 522, height });
    await expect
      .poll(() =>
        board.evaluate((element) => {
          const panel = element.closest('[role="tabpanel"]')!;
          return (
            panel.scrollHeight <= panel.clientHeight + 1 &&
            panel.scrollWidth <= panel.clientWidth + 1
          );
        }),
      )
      .toBe(true);
    const box = (await board.boundingBox())!;
    expect(box.width).toBeLessThan(514);
    expect(Math.abs(box.width / box.height - 458 / 500)).toBeLessThan(0.002);
    for (const card of await page.getByTestId("player-card").all()) {
      expect((await card.boundingBox())!.height).toBe(48);
      await expect(card).toBeInViewport({ ratio: 1 });
    }
    await expect(page.getByRole("button", { name: "棋譜を1つ戻る", exact: true })).toBeInViewport({
      ratio: 1,
    });
    if (height === 773)
      await info.attach("添付画像と同じ画面サイズの保存棋譜", {
        body: await page.screenshot({ path: info.outputPath("shogi-mobile-522x773.png") }),
        contentType: "image/png",
      });
  }
  await selectFrame(page, "開始局面");
  await expect(board.getByRole("button", { name: /裏王/ })).toHaveCount(0);
  await info.attach("低い画面の保存棋譜", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("棋譜から戻ると両カードのゲームとゲーム別モードを復元する", async ({ page }) => {
  const fixture = shogiReplayMatch("doubles");
  await setup(page, fixture);
  await page.goto("/account");
  const stats = page.getByRole("region", { name: "戦績", exact: true });
  const history = page.getByTestId("account-replay-card");
  await stats.getByRole("tab", { name: "ダブルス", exact: true }).click();
  await chooseGame(page, "棋譜のゲーム", "四人将棋");
  await history.getByRole("tab", { name: "ダブルス", exact: true }).click();
  await page.getByRole("link", { name: "棋譜を見る", exact: true }).click();
  await expect(page.getByText("脱落（退室）", { exact: true })).toBeVisible();
  await selectFrame(page, "開始局面");
  await expect(page.getByText("脱落（退室）", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "結果", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("南・北チームの勝ち");
  await page.getByRole("dialog").getByRole("button", { name: "閉じる", exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL("/account");
  await expect(page.getByRole("button", { name: /棋譜のゲーム$/ })).toContainText("四人将棋");
  await expect(history.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(stats.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("link", { name: "棋譜を見る", exact: true }).click();
  await expect(page.getByText("対局終了", { exact: true })).toBeVisible();
  if (await page.getByRole("tab", { name: "ルーム", exact: true }).count())
    await page.getByRole("tab", { name: "ルーム", exact: true }).click();
  await page.getByRole("link", { name: "マイページへ戻る", exact: true }).click();
  await expect(page).toHaveURL("/account");
  await expect(page.getByRole("button", { name: /戦績のゲーム$/ })).toContainText("四人リバーシ");
  await expect(stats.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: /棋譜のゲーム$/ })).toContainText("四人将棋");
  await expect(history.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await chooseGame(page, "棋譜のゲーム", "四人リバーシ");
  await expect(history.getByRole("tab", { name: "シングルス", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("将棋棋譜の後続ページ失敗は部分局面を表示せず、同じURLの再試行で復元する", async ({
  page,
}) => {
  const fixture = shogiReplayMatch();
  await setup(page, fixture);
  let failure = true;
  await page.route(/\/api\/account\/matches\/[^/?]+\/replay(?:\?.*)?$/, (route) => {
    const cursor = Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0);
    return route.fulfill(
      cursor === 100 && failure
        ? { status: 503, json: { message: "棋譜取得失敗" } }
        : { json: fixture.page(cursor) },
    );
  });
  await page.goto(`/account/matches/${fixture.detail.id}`);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("group", { name: "四人将棋の盤面", exact: true })).toHaveCount(0);
  failure = false;
  await page.getByRole("button", { name: "再試行", exact: true }).click();
  await expect(page.getByText("対局終了", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`/account/matches/${fixture.detail.id}`);
});

for (const status of [401, 404]) {
  test(`保存将棋棋譜の後続ページ${status}も本人制限として処理する`, async ({ page }) => {
    const fixture = shogiReplayMatch();
    await setup(page, fixture);
    if (status === 401)
      await page.route("**/api/account/session", (route) =>
        route.fulfill({ json: { user: null } }),
      );
    await page.route(/\/api\/account\/matches\/[^/?]+\/replay(?:\?.*)?$/, (route) =>
      route.fulfill({ status, json: { message: "取得不可" } }),
    );
    await page.goto(`/account/matches/${fixture.detail.id}`);
    if (status === 401) await expect(page).toHaveURL("/login");
    else await expect(page.getByRole("alert")).toHaveText("この棋譜は閲覧できません。");
    await expect(page.getByRole("group", { name: "四人将棋の盤面", exact: true })).toHaveCount(0);
  });
}

test("保存将棋棋譜の最終状態が不一致なら読み取り画面を開かない", async ({ page }) => {
  const fixture = shogiReplayMatch();
  await setup(page, fixture);
  const altered = structuredClone(fixture.detail);
  altered.game.hands.north.rook = 0;
  await page.route(/\/api\/account\/matches\/[^/?]+$/, (route) =>
    route.fulfill({ json: { match: altered } }),
  );
  await page.goto(`/account/matches/${fixture.detail.id}`);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("group", { name: "四人将棋の盤面", exact: true })).toHaveCount(0);
});

test("将棋棋譜のページ取得中に移動すると通信を中止し、遅い応答で画面を戻さない", async ({
  page,
}) => {
  const fixture = shogiReplayMatch();
  await setup(page, fixture);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  let responded = false;
  const aborted: string[] = [];
  page.on("requestfailed", (request) => {
    aborted.push(request.url());
  });
  await page.route(/\/api\/account\/matches\/[^/?]+\/replay(?:\?.*)?$/, async (route) => {
    const cursor = Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0);
    if (cursor === 100) {
      requested = true;
      await held;
    }
    await route.fulfill({ json: fixture.page(cursor) }).catch(() => {});
    if (cursor === 100) responded = true;
  });
  await page.goto("/account");
  await chooseGame(page, "棋譜のゲーム", "四人将棋");
  await page.getByRole("link", { name: "棋譜を見る", exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await expect(
    page.getByRole("status").filter({ hasText: "棋譜を読み込んでいます" }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "四人将棋の盤面", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "ロビーへ", exact: true }).click();
  await expect(page).toHaveURL("/games/four-reversi");
  await expect
    .poll(() => aborted.some((url) => new URL(url).searchParams.get("cursor") === "100"))
    .toBe(true);
  release();
  await expect.poll(() => responded).toBe(true);
  await expect(page).toHaveURL("/games/four-reversi");
  await expect(page.getByRole("heading", { name: "四人リバーシ", exact: true })).toBeVisible();
});
