import { expect, test, type Page } from "@playwright/test";
import { roomSchema, type Room } from "@tetraboard/protocol";
import { mockRoom, waitingRoom, playingRoom, playerIds } from "./fixtures";
import { waitingShogiRoom, playingShogiRoom } from "./fourShogiFixtures";
import { mockAccount, profile } from "./accountFixtures";
import { replayMatch } from "./matchReplayFixtures";
import { shogiReplayMatch } from "./fourShogiRecordFixtures";

const sizes = [
  { width: 1280, height: 400 },
  { width: 1281, height: 400 },
  { width: 1280, height: 500 },
  { width: 1280, height: 600 },
  { width: 1440, height: 400 },
  { width: 1280, height: 757 },
  { width: 1440, height: 1000 },
];
async function verify(page: Page, shogi: boolean, screenshot: string) {
  const main = page.locator("main");
  const board = page.getByRole("group", {
    name: shogi ? "四人将棋の盤面" : "四人リバーシの盤面",
    exact: true,
  });
  const info = test.info();
  async function capture(position: string) {
    const path = info.outputPath(`${screenshot}-${position}.png`);
    await page.screenshot({ path });
    await info.attach(`${screenshot}-${position}`, { path, contentType: "image/png" });
  }
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(main).toHaveCSS("overflow-y", "auto");
    await main.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect
      .poll(async () => {
        const b = (await board.boundingBox())!;
        return Math.abs(b.width / b.height - (shogi ? 458 / 500 : 1));
      })
      .toBeLessThan(0.002);
    const cards = await page
      .getByTestId("player-card")
      .evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().height));
    expect(cards).toHaveLength(4);
    for (const height of cards) expect(Math.abs(height - 60)).toBeLessThanOrEqual(1);
    expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const needsScroll = await main.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    if (size.height === 400) expect(needsScroll).toBe(true);
    if (size.height === 1000) expect(needsScroll).toBe(false);
    if (needsScroll) {
      const box = (await board.boundingBox())!;
      await page.mouse.move(
        box.x + box.width / 2,
        Math.min(size.height - 20, box.y + box.height / 2),
      );
      await page.mouse.wheel(0, 2000);
      await expect
        .poll(() => main.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
        .toBeLessThanOrEqual(1);
    }
    const bounds = await page
      .getByRole("region", { name: "盤面とプレイヤー", exact: true })
      .evaluate((el) => {
        const section = el.getBoundingClientRect();
        const children = [
          ...el.querySelectorAll(
            '[data-testid="player-card"], [role="group"], [aria-label="棋譜を1つ進む"]',
          ),
        ].map((node) => node.getBoundingClientRect());
        return children
          .filter((b) => b.width > 0 && b.height > 0)
          .every((b) => b.top >= section.top - 1 && b.bottom <= section.bottom + 1);
      });
    expect(bounds).toBe(true);
    const chat = await page.getByRole("region", { name: "チャット", exact: true }).boundingBox();
    expect(chat!.y + chat!.height).toBeLessThanOrEqual(size.height + 1);
    if (size.width === 1280 && size.height === 400) await capture("bottom");
    await page.mouse.move(20, 20);
    await page.mouse.wheel(0, -2000);
    await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(1);
    if (size.width === 1280 && size.height === 400) await capture("top");
  }
  await page.setViewportSize({ width: 1279, height: 400 });
  await expect(page.getByRole("tablist")).toBeVisible();
  await expect(main).toHaveCSS("overflow-y", "hidden");
  await page.setViewportSize({ width: 1280, height: 400 });
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await page.reload();
  await expect(board).toBeVisible();
  await expect(main).toHaveCSS("overflow-y", "auto");
  const input = page.getByRole("textbox", { name: "メッセージ", exact: true });
  const target = (await input.count())
    ? input
    : page.getByRole("button", { name: "棋譜を1つ戻る", exact: true });
  await expect(target).toBeEnabled();
  await main.evaluate((el) => {
    (document.activeElement as HTMLElement)?.blur();
    el.scrollTop = 0;
  });
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(target).toBeFocused();
  const focusBox = (await target.boundingBox())!;
  expect(focusBox.y).toBeGreaterThanOrEqual(0);
  expect(focusBox.y + focusBox.height).toBeLessThanOrEqual(400);
  expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
}
for (const game of ["four-reversi", "four-shogi"] as const) {
  const shogi = game === "four-shogi";
  for (const state of ["host-settings", "non-host", "playing", "recent-replay"] as const) {
    test(`${game} ${state} 低いPC画面を全体スクロール`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 400 });
      let room: Room = shogi ? waitingShogiRoom() : waitingRoom();
      if (state === "host-settings") {
        room = roomSchema.parse({
          ...room,
          players: room.players.map((player, i) =>
            i === 0
              ? { ...player, ready: true }
              : {
                  id: player.id,
                  reconnectDeadline: null,
                  ...(shogi ? { side: null } : { color: null }),
                  kind: "cpu",
                  name: `CPU Lv${(i % 2) + 1}`,
                  level: (i % 2) + 1,
                  ready: true,
                },
          ),
        });
      }
      if (state === "playing") room = shogi ? playingShogiRoom() : playingRoom();
      if (state === "recent-replay") {
        if (shogi) {
          const match = shogiReplayMatch();
          room = roomSchema.parse({
            ...room,
            lastRound: {
              game: match.detail.game,
              roundId: match.detail.id,
              eventCount: match.events.length,
              players: match.detail.participants.map(({ id, name, side }) => ({ id, name, side })),
            },
          });
          await page.route("**/api/rooms/12345/rounds/*/replay?*", (route) => {
            const { matchId, ...chunk } = match.page(
              Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0),
            );
            return route.fulfill({
              json: { ...chunk, roundId: matchId, instanceId: room.instanceId },
            });
          });
        } else {
          const match = replayMatch();
          room = roomSchema.parse({
            ...room,
            lastRound: {
              game: match.game,
              replay: match.replay,
              players: match.participants.map(({ id, name, color }) => ({ id, name, color })),
            },
          });
        }
      }
      await mockRoom(
        page,
        room,
        true,
        state === "non-host" ? { playerId: playerIds[1]!, role: "player" } : undefined,
      );
      await page.goto("/rooms/12345");
      await expect(
        page.getByRole("button", { name: "招待リンクをコピー", exact: true }),
      ).toBeVisible();
      if (state === "host-settings")
        await page.getByRole("button", { name: "ルーム設定", exact: true }).click();
      if (state === "recent-replay")
        await expect(
          page.getByRole("button", { name: "棋譜を1つ戻る", exact: true }),
        ).toBeEnabled();
      await verify(page, shogi, `${game}-${state}`);
    });
  }
  test(`${game} 保存棋譜も全体スクロール`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 400 });
    await mockAccount(page, profile);
    const match = shogiReplayMatch();
    const reversi = replayMatch();
    const detail = shogi ? match.detail : reversi;
    await page.route(/\/api\/account\/matches\/[^/?]+$/, (route) =>
      route.fulfill({ json: { match: detail } }),
    );
    if (shogi)
      await page.route(/\/api\/account\/matches\/[^/?]+\/replay(?:\?.*)?$/, (route) =>
        route.fulfill({
          json: match.page(Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0)),
        }),
      );
    await page.goto(`/account/matches/${detail.id}`);
    await expect(page.getByRole("button", { name: "棋譜を1つ戻る", exact: true })).toBeEnabled();
    await verify(page, shogi, `${game}-saved-replay`);
  });
}
