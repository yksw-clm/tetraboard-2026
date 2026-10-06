import { expect, test, type Page } from "@playwright/test";
import { roomTimeControl, type FourReversiRankings, type RankingEntry } from "@tetraboard/protocol";
import { mockLobby, now, playerIds, waitingRoom } from "./fixtures";

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

function lobbyRegionNames(page: Page) {
  return page
    .locator("main > div")
    .last()
    .evaluate((element) =>
      Array.from(element.children).map(
        (child) =>
          child.getAttribute("aria-label") ??
          document.getElementById(child.getAttribute("aria-labelledby") ?? "")?.textContent,
      ),
    );
}

for (const width of [320, 390, 767, 768, 1024, 1440]) {
  test(`ロビーの盤面・等幅配置・上位3人と詳細10人 ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    const play = page.getByRole("region", { name: "対局を始める", exact: true });
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
    const rooms = page.getByRole("region", { name: "公開ルーム", exact: true });
    const roomBounds = (await rooms.boundingBox())!;
    const left = (await play.boundingBox())!;
    const right = (await ranking.boundingBox())!;
    if (width >= 768) {
      expect(Math.abs(left.width - right.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
      expect(right.x).toBeGreaterThan(left.x + left.width);
      expect(roomBounds.y).toBeGreaterThan(left.y + left.height);
    } else {
      expect(Math.abs(left.x - right.x)).toBeLessThanOrEqual(1);
      expect(roomBounds.y).toBeGreaterThan(left.y + left.height);
      expect(right.y).toBeGreaterThan(roomBounds.y + roomBounds.height);
    }
    const buttons = play.getByRole("button");
    await expect(buttons).toHaveText([
      /すぐ遊ぶ.*CPU3人と対戦/,
      /ルームを作る.*友達を招待して、一緒に対戦/,
      /ルーム番号で参加.*5桁の番号を入力して合流/,
    ]);
    for (const description of [
      "CPU3人と対戦",
      "友達を招待して、一緒に対戦",
      "5桁の番号を入力して合流",
    ]) {
      const text = play.getByText(description, { exact: true });
      await expect(text).toBeVisible();
      const lines = await text.evaluate(
        (element) =>
          element.getBoundingClientRect().height /
          Number.parseFloat(getComputedStyle(element).lineHeight),
      );
      expect(lines).toBeLessThanOrEqual(1.1);
    }
    await expect(buttons.nth(0)).toHaveCSS("background-color", "rgb(39, 132, 85)");
    await expect(buttons.nth(1)).toHaveCSS("background-color", "rgb(255, 255, 255)");
    const groupLabel = (await play.getByRole("heading", { name: "みんなで遊ぶ" }).boundingBox())!;
    const quickBounds = (await buttons.nth(0).boundingBox())!;
    const createBounds = (await buttons.nth(1).boundingBox())!;
    expect(groupLabel.y).toBeGreaterThan(quickBounds.y + quickBounds.height);
    expect(createBounds.y).toBeGreaterThan(groupLabel.y + groupLabel.height);
    const regionNames = await play
      .locator("..")
      .getByRole("region")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const labelId = element.getAttribute("aria-labelledby");
          return (
            element.getAttribute("aria-label") ??
            document.getElementById(labelId ?? "")?.textContent
          );
        }),
      );
    expect(regionNames).toEqual(
      width < 768
        ? ["対局を始める", "公開ルーム", "最近行われた対局", "ランキング"]
        : ["対局を始める", "ランキング", "公開ルーム", "最近行われた対局"],
    );
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
    await expect(play.getByText("CPU3人と対戦", { exact: true })).toHaveCount(1);
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

test("スマートフォンとPCの切替でDOM順を合わせ、ランキングの選択・取得結果・詳細を保持する", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockLobby(page);
  await page.route("**/api/avatars/*", (route) => route.fulfill({ status: 404 }));
  let requests = 0;
  await page.route(path, (route) => {
    requests++;
    return route.fulfill({ json: data });
  });
  await page.goto("/games/four-reversi");
  const ranking = page.getByRole("region", { name: "ランキング", exact: true });
  await expect(ranking.getByRole("listitem")).toHaveCount(3);
  await ranking.getByRole("tab", { name: "ダブルス", exact: true }).click();
  await ranking.getByRole("button", { name: "もっと見る" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: "対局数", exact: true }).click();
  for (const width of [767, 768, 320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "対局数", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(dialog.getByRole("list", { name: "対局数ランキング" })).toContainText("複局2");
    // モーダル表示中の背景もDOM順だけを確認します。
    await expect
      .poll(() => lobbyRegionNames(page))
      .toEqual(
        width < 768
          ? ["対局を始める", "公開ルーム", "最近行われた対局", "ランキング"]
          : ["対局を始める", "ランキング", "公開ルーム", "最近行われた対局"],
      );
  }
  await page.keyboard.press("Escape");
  await expect(ranking.getByRole("button", { name: "もっと見る" })).toBeFocused();
  await expect(ranking.getByRole("tab", { name: "ダブルス", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(ranking.getByRole("list", { name: "勝利数ランキング" })).toContainText("勝利2");
  expect(requests).toBe(1);
  await page.setViewportSize({ width: 320, height: 900 });
  // matchMediaによるDOMの並べ替えを待ってから、キーボード順を確認します。
  await expect
    .poll(() => lobbyRegionNames(page))
    .toEqual(["対局を始める", "公開ルーム", "最近行われた対局", "ランキング"]);
  const play = page.getByRole("region", { name: "対局を始める" });
  const join = play.getByRole("button", { name: /^ルーム番号で参加/ });
  await join.focus();
  await expect(join).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page
      .getByRole("region", { name: "公開ルーム" })
      .getByRole("button", { name: "更新", exact: true }),
  ).toBeFocused();
});

for (const width of [320, 390, 767, 768, 1024, 1440]) {
  test(`公開ルーム0件・少数・多数の高さと末尾の操作 ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await mockLobby(page);
    let count = 0;
    let more = false;
    const metadata = (id: string) => ({
      id,
      game: "four-reversi",
      mode: "singles",
      timeControl: roomTimeControl,
      status: "waiting",
      hostName: "あいうえおかきくけこ",
      hostAvatarUrl: null,
      humanCount: 1,
      cpuCount: 0,
      capacity: 4,
      openSeats: 3,
      updatedAtMs: now,
    });
    await page.route("**/api/rooms", (route) =>
      route.fulfill({
        json: {
          rooms: Array.from({ length: count }, (_, index) => metadata(String(10001 + index))),
          nextCursor: more ? `${now}:10020` : null,
        },
      }),
    );
    await page.route("**/api/rooms?*", (route) =>
      route.fulfill({ json: { rooms: [metadata("20000")], nextCursor: null } }),
    );
    const room = { ...waitingRoom(), id: "20000" };
    room.players = room.players.slice(0, 1);
    const snapshot = {
      room,
      presence: { hostPlayerId: playerIds[0], connectedPlayerIds: [playerIds[0]] },
      serverNowMs: now,
    };
    await page.route("**/api/rooms/20000", (route) => route.fulfill({ json: snapshot }));
    await page.routeWebSocket("**/api/rooms/20000/ws?*", (socket) => {
      socket.send(JSON.stringify({ type: "room.snapshot", ...snapshot }));
      socket.send(JSON.stringify({ type: "room.chat.snapshot", messages: [] }));
    });
    await page.goto("/games/four-reversi");
    const rooms = page.getByRole("region", { name: "公開ルーム", exact: true });
    await expect(rooms.getByText("公開ルームはまだありません", { exact: true })).toBeVisible();
    await expect(rooms.getByRole("list")).toHaveCount(0);
    const emptyHeight = (await rooms.boundingBox())!.height;
    expect(emptyHeight).toBeLessThan(400);
    count = 1;
    await rooms.getByRole("button", { name: "更新", exact: true }).click();
    const list = rooms.getByRole("list");
    const viewport = list.locator("..");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    const small = (await viewport.boundingBox())!.height;
    expect(small).toBeLessThan(400);
    count = 20;
    more = true;
    await rooms.getByRole("button", { name: "更新", exact: true }).click();
    await expect(list.getByRole("listitem")).toHaveCount(20);
    const height = (await viewport.boundingBox())!.height;
    if (width < 768) {
      expect(height).toBe(400);
      await expect(viewport).toHaveCSS("overflow-y", "auto");
      expect(await viewport.evaluate((element) => element.scrollHeight)).toBeGreaterThan(400);
      await rooms.getByRole("button", { name: "ルーム 10020 に参加" }).focus();
      expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    } else {
      expect(height).toBeGreaterThan(400);
      await expect(viewport).toHaveCSS("max-height", "none");
    }
    const join = rooms.getByRole("button", { name: "ルーム 10020 に参加" });
    await join.click();
    await expect(page.getByRole("dialog")).toContainText("10020");
    await page.keyboard.press("Escape");
    await expect(join).toBeFocused();
    const outside = [
      rooms.getByRole("heading", { name: "公開ルーム", exact: true }),
      rooms.getByRole("button", { name: "更新", exact: true }),
      rooms.getByText("CPUを含む席数です。対局中は開始時の参加人数を表示しています。", {
        exact: true,
      }),
      rooms.getByRole("button", { name: "もっと見る" }),
    ];
    for (const locator of outside)
      expect(
        await locator.evaluate((element) =>
          element.closest("section")!.querySelector("ul")!.parentElement!.contains(element),
        ),
      ).toBe(false);
    await rooms.getByRole("button", { name: "もっと見る" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(21);
    if (width < 768) expect((await viewport.boundingBox())!.height).toBe(400);
    await expect(rooms.getByRole("button", { name: "もっと見る" })).toHaveCount(0);
    await rooms.getByRole("button", { name: "ルーム 20000 を観戦" }).focus();
    await info.attach("lobby-room-scroll", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await rooms.getByRole("button", { name: "ルーム 20000 を観戦" }).click();
    await expect(page).toHaveURL(/\/rooms\/20000$/);
    await expect(page.getByRole("button", { name: "参加する", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
  });
}
