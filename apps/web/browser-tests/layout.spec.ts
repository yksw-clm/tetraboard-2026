import { expect, test } from "@playwright/test";
import { mockLobby, mockRoom, waitingRoom, widths } from "./fixtures";

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
      expect(card.height).toBe(60);
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
