import { expect, test } from "@playwright/test";
import { applyAction, getLegalMoves, type FourReversiState } from "@tetraboard/four-reversi";
import { fourReversiRoomSchema } from "@tetraboard/protocol";
import { mockLobby, mockRoom, playingRoom, waitingRoom, widths } from "./fixtures";

for (const width of widths) {
  test(`ロビーと4席の配置を維持する ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockLobby(page);
    const room = await mockRoom(page);
    await page.goto("/games/four-reversi");
    await expect(page.getByRole("heading", { name: "四人リバーシ", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await testInfo.attach("lobby", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.goto("/rooms/12345");
    await expect(page.getByRole("button", { name: "準備完了", exact: true })).toBeEnabled();
    // カード内の部分要素だけは寸法計測のためのセレクターで参照します。
    const players = page.getByTestId("player-card");
    await expect(players).toHaveCount(4);
    const measure = () =>
      players.evaluateAll((elements) =>
        elements.map((card) => {
          const rect = card.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }),
      );
    const before = await measure();
    for (const card of before) {
      expect(Math.abs(card.width - before[0]!.width)).toBeLessThanOrEqual(1);
      expect(card.height).toBe(width <= 767 ? 48 : 60);
    }
    await expect
      .poll(() =>
        players.getByTestId("player-name").evaluateAll((boxes) =>
          boxes.every((box) => {
            const content = box.firstElementChild!.getBoundingClientRect();
            return content.width <= box.clientWidth + 1;
          }),
        ),
      )
      .toBe(true);
    for (const icon of await players.getByTestId("player-avatar").locator("svg").all())
      await expect(icon).toBeVisible();
    for (const badge of await players.getByLabel("接続中", { exact: true }).all())
      await expect(badge).toBeVisible();
    const ready = waitingRoom();
    ready.players.forEach((player) => {
      player.ready = true;
    });
    room.update(ready);
    await expect(page.getByRole("button", { name: "準備取消" })).toBeEnabled();
    expect(await measure()).toEqual(before);
    await testInfo.attach("room", { body: await page.screenshot(), contentType: "image/png" });
  });
}

for (const width of [320, 390, 522, 767]) {
  test(`${width}pxで高さ不足のリバーシ盤だけを中央で縮小し、4席の寸法を維持する`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = await mockRoom(page);
    await page.goto("/rooms/12345");
    const board = page.getByRole("group", { name: "四人リバーシの盤面", exact: true });
    const cards = page.getByTestId("player-card");
    await expect(cards).toHaveCount(4);
    const cardSizes = () =>
      cards.evaluateAll((elements) =>
        elements.map((element) => {
          const { width, height } = element.getBoundingClientRect();
          return { width, height };
        }),
      );
    const originalCards = await cardSizes();
    const originalBoard = (await board.boundingBox())!;
    for (const height of [640, 480, 360]) {
      await page.setViewportSize({ width, height });
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
      const center = await board.evaluate((element) => {
        const panel = element.closest('[role="tabpanel"]')!.getBoundingClientRect();
        return panel.x + panel.width / 2;
      });
      expect(Math.abs(box.width - box.height)).toBeLessThan(1);
      expect(Math.abs(box.x + box.width / 2 - center)).toBeLessThan(1);
      if (height <= 480) expect(box.width).toBeLessThan(originalBoard.width);
      expect(await cardSizes()).toEqual(originalCards);
      for (const card of await cards.all()) await expect(card).toBeInViewport({ ratio: 1 });
      if (width === 522 && height === 640)
        await info.attach("高さ640pxのリバーシ", {
          body: await page.screenshot({ path: info.outputPath("reversi-mobile-522x640.png") }),
          contentType: "image/png",
        });
    }
    await page.getByRole("tab", { name: "ルーム", exact: true }).click();
    await page.getByRole("tab", { name: "盤面", exact: true }).click();
    expect(await cardSizes()).toEqual(originalCards);
    const playing = playingRoom();
    if (playing.status !== "playing") throw new Error("Expected playing fixture");
    fixture.update(playing);
    const move = board.getByRole("button", { name: "C4：空き、置けます", exact: true });
    await expect(move).toBeEnabled();
    await move.click();
    await expect
      .poll(() =>
        fixture.received.some(
          (message) => message.type === "room.game.action" && message.action.type === "placeStone",
        ),
      )
      .toBe(true);

    let game: FourReversiState = playing.game;
    while (game.status === "playing" && game.consecutivePasses.length === 0) {
      const next = applyAction(game, { type: "placeStone", position: getLegalMoves(game)[0]! });
      if (!next.ok) throw new Error("Invalid pass fixture move");
      game = next.state;
    }
    if (game.status !== "playing") throw new Error("Expected a playing state with automatic pass");
    fixture.update(fourReversiRoomSchema.parse({ ...playing, game }));
    await expect(page.getByRole("status").filter({ hasText: "自動パス：" })).toBeInViewport({
      ratio: 1,
    });
    await expect
      .poll(() =>
        board.evaluate((element) => {
          const panel = element.closest('[role="tabpanel"]')!;
          return panel.scrollHeight <= panel.clientHeight + 1;
        }),
      )
      .toBe(true);
    for (const card of await cards.all()) await expect(card).toBeInViewport({ ratio: 1 });
  });
}
