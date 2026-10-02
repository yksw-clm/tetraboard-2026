import { expect, test, type Page } from "@playwright/test";
import { mockAccount, profile } from "./accountFixtures";
import { replayMatch } from "./matchReplayFixtures";
import { replayFrames } from "../src/features/room/replayFrames";

async function mockReplay(page: Page, match = replayMatch()) {
  await mockAccount(page, profile);
  const online: string[] = [];
  const sockets: string[] = [];
  page.on("request", (request) => {
    if (/\/rooms(?:\/|\?|$)/.test(new URL(request.url()).pathname)) online.push(request.url());
  });
  page.on("websocket", (socket) => {
    // Viteの開発用HMR接続はアプリの通信ではありません。
    const url = new URL(socket.url());
    if (url.pathname !== "/" || !url.searchParams.has("token")) sockets.push(socket.url());
  });
  await page.route("**/api/account/matches/*", (route) => route.fulfill({ json: { match } }));
  await page.route("**/api/account/matches?**", (route) =>
    route.fulfill({
      json: {
        matches: [
          {
            id: match.id,
            game: match.settings.game,
            mode: match.settings.mode,
            startedAtMs: match.startedAtMs,
            endedAtMs: match.endedAtMs,
            participants: match.participants,
            result: match.game.result,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  return { online, sockets };
}
const board = (page: Page) => page.getByRole("group", { name: "四人リバーシの盤面" });
async function selectFrame(page: Page, label: string) {
  await page.getByRole("button", { name: "棋譜の局面" }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

for (const width of [320, 390, 768, 1279, 1280, 1440]) {
  test(`${width}pxで一覧から棋譜を開き、局面とカードをローカルで操作する`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const match = replayMatch();
    const traffic = await mockReplay(page, match);
    await page.goto("/account");
    await page.getByRole("link", { name: "棋譜を見る", exact: true }).click();
    await expect(page).toHaveURL(`/account/matches/${match.id}`);
    await expect(page.getByText("対局終了", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const self = page.getByTestId("player-card").filter({ hasText: match.participants[1].name });
    await expect(self).toHaveAccessibleName(`${match.participants[1].name}、あなた`);
    expect(await self.evaluate((element) => getComputedStyle(element).gridArea)).toBe("bottom");
    await expect(self.getByText("2位（通信切れ）", { exact: true })).toBeVisible();
    await expect(self.getByTestId("player-stone-count")).toHaveAccessibleName("黒");
    const cells = board(page).getByRole("button");
    await expect(cells).toHaveCount(64);
    for (const cell of await cells.all()) await expect(cell).toBeDisabled();
    await expect(board(page).getByRole("button", { name: /置けます/ })).toHaveCount(0);
    await expect(board(page).getByRole("button", { name: /C4.*直前の手/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "棋譜を1つ進む" })).toBeDisabled();
    await selectFrame(page, "開始局面");
    await expect(page.getByRole("button", { name: "棋譜を1つ戻る" })).toBeDisabled();
    await expect(self.getByTestId("player-stone-count")).toHaveAccessibleName("黒、2石");
    await expect(board(page).getByRole("button", { name: /直前の手/ })).toHaveCount(0);
    await expect(page.getByText(/位（|脱落（/)).toHaveCount(0);
    await page.getByRole("button", { name: "棋譜を1つ進む" }).click();
    await expect(self.getByTestId("player-stone-count")).toHaveAccessibleName("黒、4石");
    await page.getByRole("button", { name: "棋譜を1つ戻る" }).click();
    await expect(self.getByTestId("player-stone-count")).toHaveAccessibleName("黒、2石");
    if (width < 1280) {
      await expect(page.getByRole("tab", { name: "チャット", exact: true })).toHaveCount(0);
      await page.getByRole("tab", { name: "ルーム", exact: true }).click();
    } else {
      await expect(
        page.getByText("棋譜閲覧ではチャットを利用できません。", { exact: true }),
      ).toBeVisible();
    }
    await expect(page.getByText("棋譜を閲覧中です。", { exact: true })).toBeVisible();
    await expect(page.getByText("#12345", { exact: true })).toBeVisible();
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
    await expect(page.getByText("ルーム設定", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel(/接続中|切断中/)).toHaveCount(0);
    if (width < 1280) {
      await page.getByRole("button", { name: "棋譜を1つ進む" }).click();
      await page.getByRole("tab", { name: "盤面", exact: true }).click();
      await expect(self.getByTestId("player-stone-count")).toHaveAccessibleName("黒、4石");
    }
    await page.getByRole("button", { name: "結果", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "対局結果" });
    await expect(
      dialog.getByText("終局理由：最後の1人になったため", { exact: true }),
    ).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(page.getByRole("button", { name: "結果", exact: true })).toBeFocused();
    await page.reload();
    await expect(self.getByText("2位（通信切れ）", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await testInfo.attach("棋譜閲覧", { body: await page.screenshot(), contentType: "image/png" });
    if (width < 1280) await page.getByRole("tab", { name: "ルーム", exact: true }).click();
    await page.getByRole("link", { name: "マイページへ戻る", exact: true }).click();
    await expect(page).toHaveURL("/account");
    expect(traffic).toEqual({ online: [], sockets: [] });
  });
}

test("ダブルスの脱落・勝敗と通常終局の自動パスを閲覧できる", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const match = replayMatch("doubles");
  const traffic = await mockReplay(page, match);
  await page.goto(`/account/matches/${match.id}`);
  await expect(page.getByText("脱落（退室）", { exact: true })).toBeVisible();
  await selectFrame(page, "1: 黒C4");
  await expect(page.getByText("脱落（退室）", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "結果", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("勝敗：黒・赤チームの勝ち", { exact: true }),
  ).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "閉じる", exact: true }).click();
  const normal = replayMatch("doubles", true, 2);
  await page.route("**/api/account/matches/*", (route) =>
    route.fulfill({ json: { match: normal } }),
  );
  await page.goto(`/account/matches/${normal.id}`);
  await expect(page.getByRole("button", { name: "棋譜を1つ進む" })).toBeDisabled();
  const frames = replayFrames({ ...normal, players: normal.participants });
  const passIndex = frames.findIndex((frame) => frame.label.endsWith("パス"));
  await page.getByRole("button", { name: "棋譜の局面" }).click();
  await page.getByRole("option").nth(passIndex).click();
  const selected = frames[passIndex].game;
  for (const player of normal.participants) {
    const card = page.getByTestId("player-card").filter({ hasText: player.name });
    await expect(card.getByTestId("player-stone-count")).toContainText(
      String(selected.board.flat().filter((cell) => cell === player.color).length),
    );
  }
  expect(traffic).toEqual({ online: [], sockets: [] });
});

for (const status of [400, 404, 503]) {
  test(`${status}の案内と503の再試行を表示する`, async ({ page }) => {
    const match = replayMatch();
    const traffic = await mockReplay(page, match);
    let failure = true;
    await page.route("**/api/account/matches/*", (route) =>
      route.fulfill(failure ? { status, json: { message: "取得不可" } } : { json: { match } }),
    );
    await page.goto(`/account/matches/${match.id}`);
    await expect(page.getByRole("alert")).toHaveText(
      status === 400
        ? "棋譜のURLが正しくありません。"
        : status === 404
          ? "この棋譜は閲覧できません。"
          : "棋譜を取得できませんでした。もう一度お試しください。",
    );
    if (status === 503) {
      failure = false;
      await page.getByRole("button", { name: "再試行", exact: true }).click();
      await expect(page.getByText("対局終了", { exact: true })).toBeVisible();
    } else await expect(page.getByRole("button", { name: "再試行", exact: true })).toHaveCount(0);
    expect(traffic).toEqual({ online: [], sockets: [] });
  });
}

test("未ログインはログイン画面へ移動する", async ({ page }) => {
  await mockAccount(page, null);
  await page.route("**/api/account/matches/*", (route) =>
    route.fulfill({ status: 401, json: { message: "ログインしてください。" } }),
  );
  await page.goto(`/account/matches/${replayMatch().id}`);
  await expect(page).toHaveURL("/login");
});

test("取得中を案内し、局面操作で再取得せず、既存の参加資格を保持する", async ({ page }) => {
  const match = replayMatch();
  const traffic = await mockReplay(page, match);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  await page.route("**/api/account/matches/*", async (route) => {
    reads++;
    await held;
    await route.fulfill({ json: { match } });
  });
  await page.goto("/account");
  await page.evaluate(() =>
    sessionStorage.setItem("tetraboard:room:12345:membership", "a".repeat(64)),
  );
  await page.getByRole("link", { name: "棋譜を見る", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "棋譜を読み込んでいます…" }),
  ).toBeVisible();
  release();
  await expect(page.getByText("対局終了", { exact: true })).toBeVisible();
  await selectFrame(page, "開始局面");
  await page.getByRole("button", { name: "棋譜を1つ進む" }).click();
  await page.getByRole("button", { name: "結果", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "閉じる", exact: true }).click();
  expect(reads).toBe(1);
  expect(
    await page.evaluate(() => sessionStorage.getItem("tetraboard:room:12345:membership")),
  ).toBe("a".repeat(64));
  expect(traffic).toEqual({ online: [], sockets: [] });
});

test("再試行中は連打を防ぎ、連続失敗の後も成功した棋譜へ戻れる", async ({ page }) => {
  const match = replayMatch();
  const traffic = await mockReplay(page, match);
  let reads = 0;
  let finishRetry!: () => void;
  const retryResponse = new Promise<void>((resolve) => {
    finishRetry = resolve;
  });
  await page.route("**/api/account/matches/*", async (route) => {
    reads++;
    if (reads === 2) await retryResponse;
    await route.fulfill(
      reads < 3 ? { status: 503, json: { message: "取得失敗" } } : { json: { match } },
    );
  });
  await page.goto(`/account/matches/${match.id}`);
  const retry = page.getByRole("button", { name: "再試行", exact: true });
  await expect(retry).toBeEnabled();
  const historyLength = await page.evaluate(() => history.length);
  await retry.click();
  await expect(retry).toBeDisabled();
  finishRetry();
  await expect(retry).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveText(
    "棋譜を取得できませんでした。もう一度お試しください。",
  );
  await retry.click();
  await expect(page.getByText("対局終了", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(reads).toBe(3);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(traffic).toEqual({ online: [], sockets: [] });
});
