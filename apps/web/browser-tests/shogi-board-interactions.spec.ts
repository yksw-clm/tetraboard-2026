import { expect, test, type Page } from "@playwright/test";
import { applyAction, sides, type FourShogiState } from "@tetraboard/four-shogi";
import { mockRoom, membership, playerIds } from "./fixtures";
import { playingShogiRoom, tacticalShogiState } from "./fourShogiFixtures";
import { shogiBoardPosition } from "../src/features/room/shogiBoardPresentation";

const square = (page: Page, x: number, y: number) =>
  page.getByTestId("shogi-board").locator(`[data-square="${"ABCDEFGHI"[x]}${y + 1}"]`);
const menu = (page: Page) => page.getByRole("group", { name: "成りの選択", exact: true });
const moves = (received: { type: string }[]) =>
  received.filter((m) => m.type === "room.game.action");
async function openPromotion(page: Page) {
  await square(page, 3, 3).click();
  await square(page, 3, 2).click();
  await expect(menu(page)).toBeVisible();
}
async function savedChoices(page: Page) {
  return page.evaluate(() =>
    Object.keys(sessionStorage).filter((key) => key.startsWith("tetraboard:shogi-promotion:")),
  );
}

test("成り選択は更新と一時切断をまたいで復元し、確定前に送信しない", async ({ page }) => {
  const fixture = await mockRoom(page, playingShogiRoom(tacticalShogiState()));
  await page.goto("/rooms/12345");
  await openPromotion(page);
  expect(await savedChoices(page)).toHaveLength(1);
  await page.reload();
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("button", { name: "成る", exact: true })).toBeFocused();
  expect(moves(fixture.received)).toHaveLength(0);
  fixture.disconnect();
  await expect(menu(page)).toHaveCount(0);
  expect(await savedChoices(page)).toHaveLength(1);
  fixture.reconnect();
  await expect(menu(page)).toBeVisible();
  expect(moves(fixture.received)).toHaveLength(0);
  await menu(page).getByRole("button", { name: "成らない", exact: true }).click();
  await expect.poll(() => moves(fixture.received)).toHaveLength(1);
  expect(moves(fixture.received)[0]).toMatchObject({ action: { promote: false } });
  await expect.poll(() => savedChoices(page)).toHaveLength(0);
  fixture.send({ type: "room.error", error: "invalid_move" });
  await page.reload();
  await expect(square(page, 3, 3)).toBeEnabled();
  await expect(menu(page)).toHaveCount(0);
});

test("キーボードで二択を操作し、Escapeでは元の駒に戻る", async ({ page }) => {
  const fixture = await mockRoom(page, playingShogiRoom(tacticalShogiState()));
  await page.goto("/rooms/12345");
  await openPromotion(page);
  const yes = menu(page).getByRole("button", { name: "成る", exact: true });
  const no = menu(page).getByRole("button", { name: "成らない", exact: true });
  await expect(yes).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(no).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(yes).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(no).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(square(page, 3, 3)).toBeFocused();
  await expect.poll(() => savedChoices(page)).toHaveLength(0);
  expect(moves(fixture.received)).toHaveLength(0);
  await page.reload();
  await expect(square(page, 3, 3)).toBeEnabled();
  await expect(menu(page)).toHaveCount(0);
  await openPromotion(page);
  await page.keyboard.press("Enter");
  await expect.poll(() => moves(fixture.received)).toHaveLength(1);
  expect(moves(fixture.received)[0]).toMatchObject({ action: { promote: true } });
});

test("選択外の盤面・画面操作は成りを確定し、背後の操作を実行しない", async ({ page }) => {
  const fixture = await mockRoom(page, playingShogiRoom(tacticalShogiState()));
  await page.goto("/rooms/12345");
  await openPromotion(page);
  const resign = await page.getByRole("button", { name: "投了", exact: true }).boundingBox();
  expect(resign).not.toBeNull();
  await page.mouse.click(resign!.x + resign!.width / 2, resign!.y + resign!.height / 2);
  await expect.poll(() => moves(fixture.received)).toHaveLength(1);
  expect(moves(fixture.received)[0]).toMatchObject({ action: { promote: true } });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.received.filter((m) => m.type === "room.game.resign")).toHaveLength(0);
  fixture.send({ type: "room.error", error: "invalid_move" });
  await openPromotion(page);
  const empty = (await square(page, 8, 8).boundingBox())!;
  await page.mouse.click(empty.x + empty.width / 2, empty.y + empty.height / 2);
  await expect.poll(() => moves(fixture.received)).toHaveLength(2);
  expect(moves(fixture.received)[1]).toMatchObject({ action: { promote: true } });
  await expect(page.getByTestId("shogi-board").locator("[data-selected]")).toHaveCount(0);
});

test("保存した選択は別局面・次局・脱落・別本人・部屋世代へ復元しない", async ({ page }) => {
  const state = tacticalShogiState();
  const fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345");
  await openPromotion(page);
  fixture.update(playingShogiRoom(state, 1));
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(() => savedChoices(page)).toHaveLength(0);
  await openPromotion(page);
  const next = playingShogiRoom(state, 1);
  next.roundId = "00000000-0000-4000-8000-000000000021";
  fixture.update(next);
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(() => savedChoices(page)).toHaveLength(0);
  await openPromotion(page);
  const dead = structuredClone(next);
  dead.game.eliminations.push({ side: "south", reason: "timeout", rank: 4, group: 0 });
  dead.game.turn = "west";
  dead.legalActions = [];
  fixture.update(dead);
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(() => savedChoices(page)).toHaveLength(0);
  fixture.update(next);
  await openPromotion(page);
  fixture.send({
    type: "room.authenticated",
    membership: { playerId: playerIds[1]!, role: "player" },
  });
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(() => savedChoices(page)).toHaveLength(0);
  fixture.send({ type: "room.authenticated", membership });
  await openPromotion(page);
  const replacement = { ...next, instanceId: "00000000-0000-4000-8000-000000000011" };
  fixture.update(replacement);
  await page.reload();
  await expect(square(page, 3, 3)).toBeEnabled();
  await expect(menu(page)).toHaveCount(0);
  expect(moves(fixture.received)).toHaveLength(0);
});

test("破損した保存値と保存失敗でも、成り選択を操作できる", async ({ page }) => {
  const fixture = await mockRoom(page, playingShogiRoom(tacticalShogiState()));
  await page.goto("/rooms/12345");
  await openPromotion(page);
  await page.evaluate(() => {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("tetraboard:shogi-promotion:")) sessionStorage.setItem(key, "{bad-json");
  });
  await page.reload();
  await expect(square(page, 3, 3)).toBeEnabled();
  await expect(menu(page)).toHaveCount(0);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("tetraboard:shogi-promotion:")) throw new Error("Storage unavailable");
      original.call(this, key, value);
    };
  });
  await openPromotion(page);
  await menu(page).getByRole("button", { name: "成る", exact: true }).click();
  await expect.poll(() => moves(fixture.received)).toHaveLength(1);
});

test("中央の成り選択は移動先を境に並び、選択中のリサイズに追従する", async ({ page }) => {
  const fixture = await mockRoom(page, playingShogiRoom(tacticalShogiState()));
  await page.goto("/rooms/12345");
  await openPromotion(page);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(async () => {
        const target = await square(page, 3, 2).boundingBox();
        const choice = await menu(page).boundingBox();
        if (!target || !choice) return Infinity;
        return Math.abs(target.x + target.width / 2 - choice.x - choice.width / 2);
      })
      .toBeLessThan(1);
  }
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await expect.poll(() => moves(fixture.received)).toHaveLength(1);
  expect(moves(fixture.received)[0]).toMatchObject({ action: { promote: false } });
});

test("区域から盤の下端へ退出する成り選択も盤内に収まる", async ({ page }) => {
  const state = tacticalShogiState();
  const fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345");
  let revision = 0;
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const x of [0, 8]) {
      const board = state.board.map((row) =>
        row.map((piece) => (piece?.kind === "king" ? piece : null)),
      );
      board[4]![1] = board[4]![0]!;
      board[4]![0] = null;
      board[4]![7] = board[4]![8]!;
      board[4]![8] = null;
      board[2]![x] = { id: state.nextPieceId, kind: "rook", side: "south", promoted: false };
      fixture.update(
        playingShogiRoom(
          {
            ...state,
            board,
            nextPieceId: state.nextPieceId + 1,
            threePlayerAttackProhibited: false,
          },
          ++revision,
        ),
      );
      await square(page, x, 2).click();
      await square(page, x, 8).click();
      await expect(menu(page)).toBeVisible();
      const panel = (await page.getByTestId("shogi-board").boundingBox())!;
      const choice = (await menu(page).boundingBox())!;
      expect(choice.x).toBeGreaterThanOrEqual(panel.x);
      expect(choice.x + choice.width).toBeLessThanOrEqual(panel.x + panel.width);
      expect(choice.y + choice.height).toBeLessThanOrEqual(panel.y + panel.height);
      await page.keyboard.press("Escape");
    }
  }
  expect(moves(fixture.received)).toHaveLength(0);
});

test("同revisionでも成り・不成の合法候補が揃わなければ選択を復元しない", async ({ page }) => {
  const state = tacticalShogiState();
  const fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345");
  await openPromotion(page);
  const next = playingShogiRoom(state);
  next.legalActions = next.legalActions.filter(
    (action) => action.type !== "movePiece" || action.promote,
  );
  fixture.update(next);
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(() => savedChoices(page)).toHaveLength(0);
  await page.reload();
  await expect(square(page, 3, 3)).toBeEnabled();
  await expect(menu(page)).toHaveCount(0);
  expect(moves(fixture.received)).toHaveLength(0);
});

test.describe("タッチでの成り選択", () => {
  test.use({ hasTouch: true });
  test("タップで不成を選べ、選択外のタップは成りだけを1回送信する", async ({ page }) => {
    const fixture = await mockRoom(page, playingShogiRoom(tacticalShogiState()));
    await page.goto("/rooms/12345");
    await square(page, 3, 3).tap();
    await square(page, 3, 2).tap();
    await menu(page).getByRole("button", { name: "成らない", exact: true }).tap();
    await expect.poll(() => moves(fixture.received)).toHaveLength(1);
    expect(moves(fixture.received)[0]).toMatchObject({ action: { promote: false } });
    fixture.send({ type: "room.error", error: "invalid_move" });
    await square(page, 3, 3).tap();
    await square(page, 3, 2).tap();
    await expect(menu(page)).toBeVisible();
    const resign = (await page.getByRole("button", { name: "投了", exact: true }).boundingBox())!;
    await page.touchscreen.tap(resign.x + resign.width / 2, resign.y + resign.height / 2);
    await expect.poll(() => moves(fixture.received)).toHaveLength(2);
    expect(moves(fixture.received)[1]).toMatchObject({ action: { promote: true } });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(fixture.received.filter((m) => m.type === "room.game.resign")).toHaveLength(0);
  });
});

for (const side of sides) {
  test(`${side}方向の成り選択は盤端でも同寸の駒を左右に表示し、盤内に収まる`, async ({
    page,
  }, info) => {
    const state = tacticalShogiState(side);
    const fixture = await mockRoom(page, playingShogiRoom(state), true, {
      playerId: playerIds[sides.indexOf(side)]!,
      role: "player",
    });
    await page.goto("/rooms/12345");
    let revision = 0;
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const x of [0, 8]) {
        const from = shogiBoardPosition({ x: x === 0 ? 1 : 7, y: 1 }, side);
        const to = shogiBoardPosition({ x, y: 0 }, side);
        const edgeBoard = state.board.map((row) => row.slice());
        edgeBoard[from.y]![from.x] = {
          id: state.nextPieceId,
          side,
          kind: "silver",
          promoted: false,
        };
        edgeBoard[to.y]![to.x] = null;
        const edge: FourShogiState = {
          ...state,
          board: edgeBoard,
          nextPieceId: state.nextPieceId + 1,
          threePlayerAttackProhibited: false,
        };
        fixture.update(playingShogiRoom(edge, ++revision));
        const source = square(page, from.x, from.y);
        await expect(source).toBeEnabled();
        await source.click();
        await square(page, to.x, to.y).click();
        await expect(menu(page)).toBeVisible();
        const board = (await page.getByTestId("shogi-board").boundingBox())!;
        const bounds = (await menu(page).boundingBox())!;
        const buttons = menu(page).getByRole("button");
        await expect(buttons.nth(0)).toHaveAccessibleName("成る");
        await expect(buttons.nth(1)).toHaveAccessibleName("成らない");
        expect(bounds.x).toBeGreaterThanOrEqual(board.x);
        expect(bounds.y).toBeGreaterThanOrEqual(board.y);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(board.x + board.width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(board.y + board.height);
        const nominal = (await source.getByTestId("shogi-piece").boundingBox())!;
        for (const piece of await menu(page).getByTestId("shogi-piece").all()) {
          const image = (await piece.boundingBox())!;
          expect(Math.abs(image.width - nominal.width)).toBeLessThanOrEqual(1);
          expect(Math.abs(image.height - nominal.height)).toBeLessThanOrEqual(1);
          await expect(piece).toHaveAttribute("data-piece-direction", "up");
        }
        if (width === 320 && x === 0)
          await info.attach(`${side}-promotion.png`, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
        await page.keyboard.press("Escape");
      }
    }
    expect(moves(fixture.received)).toHaveLength(0);
  });
}

test("盤上・持ち駒のドラッグ元を隠し、取消と局面更新で復元する", async ({ page }) => {
  const state = tacticalShogiState();
  const fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345");
  const source = square(page, 4, 6);
  await expect(source).toBeEnabled();
  const hand = page
    .getByTestId("shogi-hand")
    .filter({ visible: true })
    .getByRole("button", { name: "南の持ち駒、歩3枚、選択できます" });
  for (const origin of [source, hand]) {
    const box = (await origin.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2);
    await expect(origin.getByTestId("shogi-piece")).toBeVisible();
    await expect(page.getByTestId("shogi-drag-ghost")).toHaveCount(0);
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2);
    await expect(page.getByTestId("shogi-drag-ghost")).toBeVisible();
    await expect(origin.getByTestId("shogi-piece")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(origin.getByTestId("shogi-piece")).toBeVisible();
    await expect(page.getByTestId("shogi-drag-ghost")).toHaveCount(0);
    await page.mouse.up();
  }
  await expect(hand).toHaveAccessibleName("南の持ち駒、歩3枚、選択できます");
  expect(moves(fixture.received)).toHaveLength(0);
});

test("盤上・持ち駒はホバーで浮き、選択中はホバーを外しても浮いたままになる", async ({ page }) => {
  await mockRoom(page, playingShogiRoom(tacticalShogiState()));
  await page.goto("/rooms/12345");
  const source = square(page, 4, 6);
  await expect(source).toBeEnabled();
  const hand = page
    .getByTestId("shogi-hand")
    .filter({ visible: true })
    .getByRole("button", { name: "南の持ち駒、歩3枚、選択できます" });
  for (const button of [source, hand, square(page, 4, 2)]) {
    await page.mouse.move(0, 0);
    const before = (await button.getByTestId("shogi-piece").boundingBox())!;
    await button.hover();
    await expect
      .poll(async () => {
        const after = (await button.getByTestId("shogi-piece").boundingBox())!;
        return Math.round(before.y - after.y);
      })
      .toBe(button === source || button === hand ? 2 : 0);
    if (button === source || button === hand) {
      await button.click();
      await page.mouse.move(0, 0);
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(async () => {
          const after = (await button.getByTestId("shogi-piece").boundingBox())!;
          return Math.round(before.y - after.y);
        })
        .toBe(2);
      await page.keyboard.press("Escape");
      await expect(button).toHaveAttribute("aria-pressed", "false");
      await expect
        .poll(async () => {
          const after = (await button.getByTestId("shogi-piece").boundingBox())!;
          return Math.round(before.y - after.y);
        })
        .toBe(0);
    }
  }
});

test("移動元は背景・移動先は枠で描き分け、装飾を全マスの内側に収める", async ({ page }, info) => {
  const state = tacticalShogiState();
  const action = {
    type: "movePiece" as const,
    from: { x: 4, y: 6 },
    to: { x: 4, y: 5 },
    promote: false,
  };
  const moved = applyAction(state, "south", action);
  if (!moved.ok || moved.state.status !== "playing") throw new Error("Invalid test move");
  await mockRoom(page, playingShogiRoom(moved.state), false);
  await page.goto("/rooms/12345");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const from = square(page, 4, 6).getByTestId("shogi-square-highlight");
    const to = square(page, 4, 5).getByTestId("shogi-square-highlight");
    await expect(from).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(from).toHaveCSS("box-shadow", "none");
    await expect(to).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(to).not.toHaveCSS("box-shadow", "none");
    const fits = await page.getByTestId("shogi-board").evaluate(async (board) => {
      const image = board.querySelector("img")!;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      // 実画像から罫線の範囲を読み、全81マスで線との重なりと余分な隙間を検証する。
      const lines = (axis: "x" | "y", span: number) =>
        Array.from({ length: 10 }, (_, i) => {
          const center = Math.round(6 + (span * i) / 9);
          const red = (p: number) =>
            pixels[(axis === "x" ? 30 * canvas.width + p : p * canvas.width + 30) * 4];
          const wood = (red(center - 4) + red(center + 4)) / 2;
          const line = Array.from({ length: 7 }, (_, offset) => center - 3 + offset).filter(
            (p) => red(p) < wood * 0.94,
          );
          return { start: Math.min(...line), end: Math.max(...line) + 1 };
        });
      const xs = lines("x", 446);
      const ys = lines("y", 488);
      const bounds = image.getBoundingClientRect();
      const scale = bounds.width / canvas.width;
      return Array.from(board.querySelectorAll("[data-square]")).every((cell, index) => {
        const b = cell
          .querySelector('[data-testid="shogi-square-highlight"]')!
          .getBoundingClientRect();
        const x = index % 9;
        const y = Math.floor(index / 9);
        const gaps = [
          b.left - (bounds.left + xs[x].end * scale),
          b.top - (bounds.top + ys[y].end * scale),
          bounds.left + xs[x + 1].start * scale - b.right,
          bounds.top + ys[y + 1].start * scale - b.bottom,
        ];
        // レイアウトのサブピクセル丸め（1/64px）だけ許容する。
        return gaps.every((gap) => gap >= -0.04 && gap <= 0.04);
      });
    });
    expect(fits).toBe(true);
    if (width === 390)
      await info.attach("last-move.png", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
  }
  await page.reload();
  await expect(square(page, 4, 5)).toHaveAttribute("data-last-move", "to");
  await expect(square(page, 4, 6)).toHaveAttribute("data-last-move", "from");
});
