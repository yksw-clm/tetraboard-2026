import { expect, test, type Page } from "@playwright/test";
import { applyAction, sides, type FourShogiAction } from "@tetraboard/four-shogi";
import { mockRoom, membership, playerIds, widths } from "./fixtures";
import {
  finishedShogiRound,
  initialShogiState,
  playingShogiRoom,
  shogiRoundId,
  tacticalShogiState,
  waitingShogiRoom,
} from "./fourShogiFixtures";

test.use({ hasTouch: true });

const square = (page: Page, x: number, y: number) =>
  page.getByTestId("shogi-board").locator('[data-square="' + "ABCDEFGHI"[x] + (y + 1) + '"]');
const actions = (received: { type: string }[]) =>
  received.filter((message) => message.type === "room.game.action");
async function resizeRoom(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 1000 });
  const tabs = page.getByRole("tablist", { name: "ルームの表示" });
  // CSSの幅変更だけでなく、1280px境界で外側のレイアウトが切り替わったことを待ちます。
  if (width >= 1280) await expect(tabs).toHaveCount(0);
  else await expect(tabs).toBeVisible();
  await expect(page.getByTestId("shogi-board")).toBeVisible();
}
async function drag(page: Page, from: ReturnType<typeof square>, to: ReturnType<typeof square>) {
  const a = (await from.boundingBox())!,
    b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await expect(page.getByTestId("shogi-drag-ghost")).toBeVisible();
  const ghost = (await page.getByTestId("shogi-drag-ghost").boundingBox())!;
  expect(Math.abs(ghost.x + ghost.width / 2 - (b.x + b.width / 2))).toBeLessThan(1);
  expect(Math.abs(ghost.y + ghost.height / 2 - (b.y + b.height / 2))).toBeLessThan(1);
  await page.mouse.up();
}

test("盤と持ち駒の比率・順・向き・空領域を全境界で維持する", async ({ page }, info) => {
  const state = tacticalShogiState();
  const fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345");
  await expect(square(page, 4, 6)).toBeEnabled();
  for (const width of widths) {
    await resizeRoom(page, width);
    const board = page.getByTestId("shogi-board"),
      layout = page.getByTestId("shogi-board-layout");
    await expect(board).toBeVisible();
    const box = (await board.boundingBox())!;
    expect(Math.abs(box.width / box.height - 458 / 500)).toBeLessThan(0.002);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const hands = layout.getByTestId("shogi-hand").filter({ visible: true });
    await expect(hands).toHaveCount(4);
    const nominal = await board
      .getByTestId("shogi-piece")
      .first()
      .evaluate((el) => el.clientWidth);
    for (const hand of await hands.all()) {
      const direction = await hand.getAttribute("data-hand-direction");
      expect(
        await hand
          .locator("[data-hand-kind]")
          .evaluateAll((elements) => elements.map((e) => e.getAttribute("data-hand-kind"))),
      ).toEqual(
        direction === "up" || direction === "right"
          ? ["pawn", "silver", "gold", "rook"]
          : ["rook", "gold", "silver", "pawn"],
      );
      const sizes = await hand
        .getByTestId("shogi-piece")
        .evaluateAll((elements) => elements.map((el) => (el as HTMLElement).clientWidth));
      for (const size of sizes) expect(Math.abs(size - nominal)).toBeLessThanOrEqual(1);
      await expect(hand.getByRole("button", { name: /歩3枚/ })).toHaveCount(1);
      const handBox = (await hand.boundingBox())!;
      expect(handBox.height).toBeGreaterThan(0);
      const placement = await hand.evaluate((el) =>
        el.closest("[data-board-position]")?.getAttribute("data-board-position"),
      );
      const expectedDirection =
        width <= 767
          ? placement === "left" || placement === "top"
            ? "down"
            : "up"
          : ({ left: "right", top: "down", right: "left", bottom: "up" } as const)[
              placement as "left"
            ];
      expect(direction).toBe(expectedDirection);
      if (width <= 767)
        expect(
          placement === "left" || placement === "top"
            ? handBox.y + handBox.height <= box.y + 1
            : handBox.y >= box.y + box.height - 1,
        ).toBe(true);
    }
    if ([320, 390, 768, 1440].includes(width))
      await info.attach("shogi-room-" + width, {
        body: await page.screenshot({
          fullPage: true,
          path: info.outputPath("shogi-room-" + width + ".png"),
        }),
        contentType: "image/png",
      });
  }
  const handBefore = await page
    .getByTestId("shogi-hand")
    .filter({ visible: true })
    .first()
    .boundingBox();
  fixture.update(playingShogiRoom(initialShogiState(), 1));
  const empty = page.getByTestId("shogi-hand").filter({ visible: true });
  await expect(empty.getByTestId("shogi-piece")).toHaveCount(0);
  expect((await empty.first().boundingBox())!.height).toBeGreaterThan(0);
  expect(handBefore!.height).toBeGreaterThan(0);
});

for (const side of sides) {
  test(side + "の視点は自王が下、送信は元の座標を使う", async ({ page }) => {
    const state = { ...initialShogiState(), turn: side } as ReturnType<typeof initialShogiState>;
    const fixture = await mockRoom(page, playingShogiRoom(state), true, {
      playerId: playerIds[sides.indexOf(side)]!,
      role: side === "south" ? "host" : "player",
    });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto("/rooms/12345");
    const kingPos = { south: [4, 8], west: [0, 4], north: [4, 0], east: [8, 4] }[side]!;
    const king = (await square(page, kingPos[0]!, kingPos[1]!).boundingBox())!;
    const board = (await page.getByTestId("shogi-board").boundingBox())!;
    expect(king.y).toBeGreaterThan(board.y + board.height * 0.8);
    expect(king.x).toBeGreaterThan(board.x + board.width * 0.4);
    const from = { south: [4, 6], west: [2, 4], north: [4, 2], east: [6, 4] }[side]!;
    const to = { south: [4, 5], west: [3, 4], north: [4, 3], east: [5, 4] }[side]!;
    await square(page, from[0]!, from[1]!).click();
    await square(page, to[0]!, to[1]!).click();
    await expect.poll(() => actions(fixture.received)).toHaveLength(1);
    expect(actions(fixture.received)[0]).toMatchObject({
      roundId: shogiRoundId,
      positionRevision: 0,
      action: {
        type: "movePiece",
        from: { x: from[0], y: from[1] },
        to: { x: to[0], y: to[1] },
        promote: false,
      },
    });
  });
}

test("選択・捕獲・持ち駒打ちと更新はサーバー局面に従い、二重送信を防ぐ", async ({ page }) => {
  const state = tacticalShogiState();
  const fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345");
  const source = square(page, 4, 6);
  await source.click();
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await source.click();
  await expect(source).toHaveAttribute("aria-pressed", "false");
  await source.click();
  await page.keyboard.press("Escape");
  await expect(source).toHaveAttribute("aria-pressed", "false");
  await source.click();
  await square(page, 4, 5).click();
  await expect.poll(() => actions(fixture.received)).toHaveLength(1);
  await expect(square(page, 4, 6).getByTestId("shogi-piece")).toHaveCount(1);
  await expect(source).toBeDisabled();
  const capture: FourShogiAction = {
    type: "movePiece",
    from: { x: 4, y: 6 },
    to: { x: 4, y: 5 },
    promote: false,
  };
  const next = applyAction(state, "south", capture);
  if (!next.ok) throw new Error(next.reason);
  fixture.update(
    playingShogiRoom({ ...next.state, turn: "south", status: "playing", result: null }, 1),
  );
  await expect(square(page, 4, 5)).toHaveAttribute("data-last-move", "to");
  await expect(square(page, 4, 6)).toHaveAttribute("data-last-move", "from");
  const hand = page
    .getByTestId("shogi-hand")
    .filter({ visible: true })
    .filter({ has: page.getByRole("button", { name: /南の持ち駒、歩3枚/ }) });
  await hand.getByRole("button", { name: /歩3枚/ }).click();
  await square(page, 5, 5).click();
  await expect.poll(() => actions(fixture.received)).toHaveLength(2);
  expect(actions(fixture.received)[1]).toMatchObject({
    positionRevision: 1,
    action: { type: "dropPiece", pieceKind: "pawn", to: { x: 5, y: 5 } },
  });
});

test("ドラッグ・盤外・Escape・ポインター取消とタッチで不正操作を送信しない", async ({ page }) => {
  const fixture = await mockRoom(page, playingShogiRoom(tacticalShogiState()));
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/rooms/12345");
  const source = square(page, 4, 6),
    target = square(page, 4, 5);
  await expect(source).toBeEnabled();
  const a = (await source.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 4, a.y + a.height / 2);
  await expect(page.getByTestId("shogi-drag-ghost")).toHaveCount(0);
  await page.mouse.move(2, 2, { steps: 5 });
  await page.mouse.up();
  expect(actions(fixture.received)).toHaveLength(0);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(actions(fixture.received)).toHaveLength(0);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await source.dispatchEvent("pointercancel", {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
  await page.mouse.up();
  await page.touchscreen.tap(a.x + a.width / 2, a.y + a.height / 2);
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await page.touchscreen.tap(a.x + a.width / 2, a.y + a.height / 2);
  await expect(source).toHaveAttribute("aria-pressed", "false");
  expect(actions(fixture.received)).toHaveLength(0);
  await expect(source).toHaveCSS("touch-action", "none");
  await expect(square(page, 4, 0)).toHaveCSS("touch-action", "auto");
  await drag(page, source, target);
  await expect.poll(() => actions(fixture.received)).toHaveLength(1);
  expect(actions(fixture.received)[0]).toMatchObject({
    action: { type: "movePiece", from: { x: 4, y: 6 }, to: { x: 4, y: 5 }, promote: false },
  });
  for (const width of [768, 1280, 1440]) {
    fixture.send({ type: "room.error", error: "invalid_move" });
    await resizeRoom(page, width);
    await expect(source).toBeVisible();
    await expect(source).toBeEnabled();
    const count = actions(fixture.received).length;
    await drag(page, source, target);
    await expect.poll(() => actions(fixture.received)).toHaveLength(count + 1);
  }
});

test("任意成り・強制成り・成り選択中の更新を扱う", async ({ page }) => {
  const state = tacticalShogiState(),
    fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345");
  await square(page, 3, 3).click();
  await square(page, 3, 2).click();
  const dialog = page.getByRole("dialog", { name: "成りますか？" });
  await expect(dialog).toBeVisible();
  expect(actions(fixture.received)).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(square(page, 3, 3)).toHaveAttribute("aria-pressed", "false");
  expect(actions(fixture.received)).toHaveLength(0);
  await square(page, 3, 3).click();
  await square(page, 3, 2).click();
  await expect(dialog).toBeVisible();
  fixture.update(playingShogiRoom(state, 1));
  await expect(dialog).toHaveCount(0);
  await square(page, 3, 3).click();
  await square(page, 3, 2).click();
  await dialog.getByRole("button", { name: "成らない", exact: true }).click();
  await expect.poll(() => actions(fixture.received)).toHaveLength(1);
  expect(actions(fixture.received)[0]).toMatchObject({ action: { promote: false } });
  fixture.send({ type: "room.error", error: "invalid_move" });
  await square(page, 3, 3).click();
  await square(page, 3, 2).click();
  await dialog.getByRole("button", { name: "成る", exact: true }).click();
  await expect.poll(() => actions(fixture.received)).toHaveLength(2);
  expect(actions(fixture.received)[1]).toMatchObject({ action: { promote: true } });
  const board = state.board.map((row) => row.slice());
  board[1]![6] = { id: 99, side: "south", kind: "pawn", promoted: false };
  fixture.update(playingShogiRoom({ ...state, board, nextPieceId: 100 }, 2));
  await square(page, 6, 1).click();
  await square(page, 6, 0).click();
  await expect.poll(() => actions(fixture.received)).toHaveLength(3);
  await expect(dialog).toHaveCount(0);
  expect(actions(fixture.received)[2]).toMatchObject({
    action: { promote: true, to: { x: 6, y: 0 } },
  });
});

test("待機・観戦・手番外は操作不可、王手・裏王・順位を表示する", async ({ page }) => {
  const fixture = await mockRoom(page, waitingShogiRoom(), false);
  await page.goto("/rooms/12345");
  await expect(page.getByTestId("shogi-board").locator("button:enabled")).toHaveCount(0);
  const state = tacticalShogiState();
  const board = state.board.map((row) => row.slice());
  board[7]![4] = { id: 99, side: "east", kind: "rook", promoted: false };
  fixture.update(
    playingShogiRoom(
      {
        ...state,
        board,
        nextPieceId: 100,
        eliminations: [{ side: "west", reason: "left", rank: 4, group: 1 }],
      },
      1,
    ),
  );
  await expect(square(page, 4, 8)).toHaveAttribute("data-check", "true");
  await expect(square(page, 0, 4)).toHaveAttribute("aria-label", /裏王/);
  await expect(page.getByTestId("player-card").filter({ hasText: "参加者2" })).toContainText("4位");
  await expect(page.getByTestId("shogi-board").locator("button:enabled")).toHaveCount(0);
  expect(actions(fixture.received)).toHaveLength(0);
});

test("直前棋譜を検証して最終局面から再生し、再戦で解除する", async ({ page }) => {
  const { room, events } = finishedShogiRound();
  room.players = [room.players[0]!, room.players[2]!, room.players[3]!, room.players[1]!];
  const fixture = await mockRoom(page, room, true, membership);
  await page.route("**/api/rooms/12345/rounds/*/replay?*", (route) =>
    route.fulfill({
      json: {
        instanceId: room.instanceId,
        roundId: shogiRoundId,
        rulesVersion: 1,
        initial: {
          mode: "singles",
          players: initialShogiState().players,
          threePlayerAttackProhibited: true,
        },
        eventCount: events.length,
        events,
        nextCursor: null,
      },
    }),
  );
  await page.goto("/rooms/12345");
  await expect(page.getByRole("button", { name: "結果", exact: true })).toBeVisible();
  const previous = page.getByRole("button", { name: "棋譜を1つ戻る" });
  await expect(previous).toBeEnabled();
  const westCard = page.getByTestId("player-card").filter({ hasText: "参加者2" });
  await expect(westCard).toContainText("4位（退室）");
  await expect(page.getByTestId("player-card").filter({ hasText: "参加者3" })).toContainText("3位");
  fixture.update({
    ...room,
    players: room.players.map((player) => ({ ...player, ready: true })),
  });
  await expect(westCard).toContainText("準備完了");
  await expect(westCard).toContainText("4位（退室）");
  await page.getByRole("button", { name: "結果", exact: true }).click();
  const result = page.getByRole("dialog", { name: /結果/ });
  await expect(result).toContainText("1位");
  await page.keyboard.press("Escape");
  await previous.click();
  await previous.click();
  await previous.click();
  await previous.click();
  await expect(previous).toBeDisabled();
  await expect(westCard).not.toContainText("4位");
  await expect(page.getByTestId("shogi-board").locator("[data-last-move]")).toHaveCount(0);
  fixture.update(playingShogiRoom());
  await expect(page.getByRole("button", { name: "棋譜を1つ戻る" })).toHaveCount(0);
});
