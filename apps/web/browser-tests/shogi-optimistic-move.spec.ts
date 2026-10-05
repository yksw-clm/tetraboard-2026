import { expect, test, type Page } from "@playwright/test";
import { applyAction, type FourShogiAction } from "@tetraboard/four-shogi";
import { mockRoom, now } from "./fixtures";
import { initialShogiState, playingShogiRoom, tacticalShogiState } from "./fourShogiFixtures";

const square = (page: Page, name: string) =>
  page.getByTestId("shogi-board").locator(`[data-square="${name}"]`);
const notice = (page: Page) => page.getByRole("status").filter({ hasText: "着手を送信中…" });
const actions = (received: { type: string }[]) =>
  received.filter((message) => message.type === "room.game.action");
async function move(page: Page, from = "E7", to = "E6") {
  await square(page, from).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(square(page, from)).toHaveAttribute("aria-pressed", "true");
  await square(page, to).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(square(page, to)).toHaveAttribute("data-pending-move", "true");
}

for (const width of [320, 768, 1440]) {
  test(`${width}px: 即時表示と3秒の通知境界・連打・確定・拒否でレイアウトを変えない`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.install({ time: now });
    const state = initialShogiState();
    const room = playingShogiRoom(state);
    const fixture = await mockRoom(page, room);
    await page.goto("/rooms/12345");
    await expect(square(page, "E7")).toBeEnabled();
    await page.clock.pauseAt(now + 60_000);
    const bounds = () =>
      page
        .getByTestId("shogi-board")
        .or(page.getByTestId("player-card"))
        .or(page.getByLabel("対局状況", { exact: true }))
        .or(page.getByRole("tablist", { name: "ルームの表示" }))
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const r = node.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          }),
        );
    const before = await bounds();
    await move(page);
    await expect(square(page, "E7").getByTestId("shogi-piece")).toHaveCount(0);
    await expect(square(page, "E6")).toHaveAccessibleName(/南の歩、未確定の移動先/);
    await expect(page.getByTestId("shogi-board").locator("button:disabled")).toHaveCount(81);
    await expect(page.getByRole("button", { name: "投了", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "引分提案", exact: true })).toBeDisabled();
    await page.evaluate(() => {
      for (let i = 0; i < 10; i++)
        (document.querySelector('[data-square="E6"]') as HTMLButtonElement).click();
    });
    await expect.poll(() => actions(fixture.received)).toHaveLength(1);
    await page.clock.runFor(2999);
    await expect(notice(page)).toHaveCount(0);
    fixture.update({
      ...room,
      players: room.players.map((p, i) => ({ ...p, name: i === 1 ? "同局面更新" : p.name })),
    });
    await expect(page.getByText("同局面更新", { exact: true })).toBeVisible();
    await page.clock.runFor(1);
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toHaveCSS("position", "absolute");
    await expect(notice(page)).toHaveCSS("pointer-events", "none");
    expect(await bounds()).toEqual(before);
    const next = applyAction(state, "south", {
      type: "movePiece",
      from: { x: 4, y: 6 },
      to: { x: 4, y: 5 },
      promote: false,
    });
    if (!next.ok) throw new Error(next.reason);
    fixture.update(playingShogiRoom(next.state, 1));
    await expect(square(page, "E6")).toHaveAttribute("data-last-move", "to");
    await expect(square(page, "E6")).not.toHaveAttribute("data-pending-move");
    await expect(notice(page)).toHaveCount(0);
    expect(await bounds()).toEqual(before);
    for (const error of ["invalid_move", "stale_position"] as const) {
      fixture.update(room);
      await expect(square(page, "E7")).toBeEnabled();
      await move(page);
      await expect(notice(page)).toHaveCount(0);
      await page.clock.runFor(2999);
      await expect(notice(page)).toHaveCount(0);
      fixture.send({ type: "room.error", error });
      await expect(square(page, "E7")).toBeEnabled();
      await expect(square(page, "E7")).toHaveAttribute("aria-pressed", "false");
      await expect(square(page, "E6").getByTestId("shogi-piece")).toHaveCount(0);
      const errorNotice = page.getByRole("status").filter({
        hasText: error === "invalid_move" ? "その手は指せません" : "局面が更新されました",
      });
      await expect(errorNotice).toBeVisible();
      await expect(errorNotice).toHaveCSS("position", "absolute");
      expect(await bounds()).toEqual(before);
      await page.clock.runFor(3001);
      await expect(notice(page)).toHaveCount(0);
    }
  });
}

test("3秒未満で確定した着手のタイマーは次の着手へ持ち越さない", async ({ page }) => {
  await page.clock.install({ time: now });
  const state = initialShogiState();
  const fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345");
  await expect(square(page, "E7")).toBeEnabled();
  await page.clock.pauseAt(now + 60_000);
  await move(page);
  await page.clock.runFor(2500);
  const next = applyAction(state, "south", {
    type: "movePiece",
    from: { x: 4, y: 6 },
    to: { x: 4, y: 5 },
    promote: false,
  });
  if (!next.ok) throw new Error(next.reason);
  if (next.state.status !== "playing") throw new Error("Expected playing state");
  // 次の本人手番を制御し、前手の期限をまたぐ。
  fixture.update(playingShogiRoom({ ...next.state, turn: "south" }, 1));
  await expect(square(page, "E6")).toBeEnabled();
  await expect(notice(page)).toHaveCount(0);
  await move(page, "E6", "E5");
  await page.clock.runFor(2999);
  await expect(notice(page)).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(notice(page)).toBeVisible();
  fixture.send({ type: "room.error", error: "invalid_move" });
  await expect(notice(page)).toHaveCount(0);
});

test("WebSocket送信の例外は盤面を確定状態に保ち、遅延通知を残さない", async ({ page }) => {
  await page.clock.install({ time: now });
  const fixture = await mockRoom(page, playingShogiRoom());
  await page.addInitScript(() => {
    const original = WebSocket.prototype.send;
    let failed = false;
    WebSocket.prototype.send = function (data) {
      if (!failed && typeof data === "string" && JSON.parse(data).type === "room.game.action") {
        failed = true;
        throw new Error("Controlled send failure");
      }
      return original.call(this, data);
    };
  });
  await page.goto("/rooms/12345");
  await expect(square(page, "E7")).toBeEnabled();
  await page.clock.pauseAt(now + 60_000);
  await square(page, "E7").evaluate((el) => (el as HTMLButtonElement).click());
  await expect(square(page, "E7")).toHaveAttribute("aria-pressed", "true");
  await square(page, "E6").evaluate((el) => (el as HTMLButtonElement).click());
  await expect(
    page.getByRole("status").filter({ hasText: "対局操作を送信できませんでした。" }),
  ).toBeVisible();
  await expect(square(page, "E7")).toBeEnabled();
  await expect(square(page, "E7")).toHaveAttribute("aria-pressed", "false");
  await expect(square(page, "E7").getByTestId("shogi-piece")).toHaveCount(1);
  await expect(square(page, "E6").getByTestId("shogi-piece")).toHaveCount(0);
  expect(actions(fixture.received)).toHaveLength(0);
  await page.clock.runFor(5000);
  await expect(notice(page)).toHaveCount(0);
  await move(page);
  await expect.poll(() => actions(fixture.received)).toHaveLength(1);
  await expect(
    page.getByRole("status").filter({ hasText: "対局操作を送信できませんでした。" }),
  ).toHaveCount(0);
});

test("切断と次局への更新は未確定表示と遅延通知を解除する", async ({ page }) => {
  await page.clock.install({ time: now });
  const room = playingShogiRoom();
  const fixture = await mockRoom(page, room);
  await page.goto("/rooms/12345");
  await expect(square(page, "E7")).toBeEnabled();
  await page.clock.pauseAt(now + 60_000);
  await move(page);
  await page.clock.runFor(3000);
  await expect(notice(page)).toBeVisible();
  fixture.disconnect();
  await expect(page.getByRole("status").filter({ hasText: "再接続中" })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await expect(square(page, "E7").getByTestId("shogi-piece")).toHaveCount(1);
  await expect(square(page, "E6")).not.toHaveAttribute("data-pending-move");
  await page.clock.runFor(1000);
  fixture.reconnect();
  await expect(square(page, "E7")).toBeEnabled();
  await move(page);
  await page.clock.runFor(2999);
  await expect(notice(page)).toHaveCount(0);
  fixture.update({ ...room, roundId: "00000000-0000-4000-8000-000000000021" });
  await expect(square(page, "E7")).toBeEnabled();
  await expect(square(page, "E7")).toHaveAttribute("aria-pressed", "false");
  await page.clock.runFor(3001);
  await expect(notice(page)).toHaveCount(0);
  await move(page);
  await page.clock.runFor(2999);
  await expect(notice(page)).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(notice(page)).toBeVisible();
});

for (const kind of ["capture", "promotion", "drop"] as const) {
  test(`${kind}: 未確定表示は駒と持ち駒を反映し、確定後の盤面と一致する`, async ({ page }) => {
    const state = tacticalShogiState();
    const action: FourShogiAction =
      kind === "drop"
        ? { type: "dropPiece", pieceKind: "pawn", to: { x: 5, y: 5 } }
        : kind === "promotion"
          ? { type: "movePiece", from: { x: 3, y: 3 }, to: { x: 3, y: 2 }, promote: true }
          : { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: false };
    const fixture = await mockRoom(page, playingShogiRoom(state));
    await page.goto("/rooms/12345");
    await expect(square(page, "E7")).toBeEnabled();
    if (action.type === "dropPiece") {
      await page
        .getByRole("button", { name: "南の持ち駒、歩3枚、選択できます", exact: true })
        .filter({ visible: true })
        .click();
    } else await square(page, `${"ABCDEFGHI"[action.from.x]}${action.from.y + 1}`).click();
    const target = square(page, `${"ABCDEFGHI"[action.to.x]}${action.to.y + 1}`);
    await target.click();
    if (kind === "promotion") await page.getByRole("button", { name: "成る", exact: true }).click();
    await expect(target).toHaveAttribute("data-pending-move", "true");
    await expect.poll(() => actions(fixture.received)).toHaveLength(1);
    expect(actions(fixture.received)[0]).toMatchObject({ action });
    const boardState = () =>
      page
        .getByTestId("shogi-board")
        .locator("[data-square]")
        .evaluateAll((nodes) =>
          nodes.map((node) =>
            node
              .getAttribute("aria-label")!
              .replace(/、未確定の移動先|、直前の移動元|、直前の移動先/g, ""),
          ),
        );
    const handState = () =>
      page
        .getByTestId("shogi-hand")
        .filter({ visible: true })
        .evaluateAll((nodes) => nodes.map((node) => node.textContent));
    const preview = await boardState();
    const previewHands = await handState();
    const next = applyAction(state, "south", action);
    if (!next.ok) throw new Error(next.reason);
    fixture.update(playingShogiRoom(next.state, 1));
    await expect(target).not.toHaveAttribute("data-pending-move");
    expect(await boardState()).toEqual(preview);
    expect(await handState()).toEqual(previewHands);
  });
}
