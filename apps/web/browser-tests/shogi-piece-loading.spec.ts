import { mockAccount, profile } from "./accountFixtures";
import { shogiReplayMatch } from "./fourShogiRecordFixtures";
import { expect, test, type Page } from "@playwright/test";
import { applyAction, eliminateSide } from "@tetraboard/four-shogi";
import { mockLobby, mockRoom, playingRoom } from "./fixtures";
import { playingShogiRoom, tacticalShogiState } from "./fourShogiFixtures";

const rareImages = /\/(?:up|down)_(?:prom_silver|prom_rook|dead_king2)-[^/]+\.png$/;
const square = (page: Page, name: string) =>
  page.getByTestId("shogi-board").locator(`[data-square="${name}"]`);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function openPromotion(page: Page) {
  await square(page, "D4").click();
  await square(page, "D3").click();
  return page.getByRole("group", { name: "成りの選択" });
}

for (const width of [320, 390, 768, 1440]) {
  for (const condition of ["pending", "error", "invalid", "decode"] as const) {
    test(`${width}px: ${condition}でも成り選択を駒名で識別して操作できる`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 950 });
      const gate = deferred();
      if (condition === "decode") {
        await page.addInitScript(() => {
          const nativeDecode = HTMLImageElement.prototype.decode;
          let release!: () => void;
          const gate = new Promise<void>((done) => {
            release = done;
          });
          Object.assign(window, { releasePieceDecode: release, pieceDecodes: 0 });
          HTMLImageElement.prototype.decode = async function () {
            await nativeDecode.call(this);
            if (/up_prom_silver-/.test(this.src)) {
              (window as unknown as { pieceDecodes: number }).pieceDecodes++;
              await gate;
            }
          };
        });
      } else {
        await page.route(rareImages, async (route) => {
          if (condition === "pending") {
            await gate.promise;
            await route.continue();
          } else if (condition === "error") await route.abort("failed");
          else await route.fulfill({ contentType: "image/png", body: "invalid png" });
        });
      }
      const fixture = await mockRoom(page, playingShogiRoom(tacticalShogiState()));
      try {
        await page.goto("/rooms/12345", { waitUntil: "domcontentloaded" });
        const menu = await openPromotion(page);
        if (condition === "decode") {
          await page.waitForFunction(
            () => (window as unknown as { pieceDecodes: number }).pieceDecodes > 0,
          );
        }
        const fallback = menu.getByText("成銀", { exact: true });
        await expect(fallback).toBeVisible();
        await expect(menu.getByRole("button", { name: "成る", exact: true })).toBeEnabled();
        const image = menu.locator('img[src*="up_prom_silver-"]');
        await expect(image).toBeHidden();
        const before = (await menu.boundingBox())!;
        await info.attach("piece-fallback", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        if (condition === "pending" || condition === "decode") {
          if (condition === "decode") {
            await page.evaluate(() =>
              (window as unknown as { releasePieceDecode: () => void }).releasePieceDecode(),
            );
          } else gate.resolve();
          await expect(image).toBeVisible();
          await expect(fallback).toHaveCount(0);
          const after = (await menu.boundingBox())!;
          expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
          expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
        }
        // 読み込みに失敗していても、画像を待たず選択を送信できます。
        if (width === 320) await page.keyboard.press("Enter");
        else if (width === 390) {
          await page.keyboard.press("Tab");
          await page.keyboard.press("Space");
        } else if (width === 768)
          await menu.getByRole("button", { name: "成る", exact: true }).click();
        else
          await page
            .getByRole("button", { name: "成りを確定", exact: true })
            .click({ position: { x: 2, y: 2 } });
        await expect
          .poll(() => fixture.received.filter((message) => message.type === "room.game.action"))
          .toHaveLength(1);
        expect(
          fixture.received.find((message) => message.type === "room.game.action"),
        ).toMatchObject({ action: { promote: width !== 390 } });
      } finally {
        gate.resolve();
      }
    });
  }
}

test("通常画像を待って2並列で6画像を準備し、表示・操作を妨げず同じ画像を再取得しない", async ({
  page,
}) => {
  const boardGate = deferred(),
    warmGate = deferred();
  let requests = 0,
    pending = 0,
    maximumPending = 0;
  const finished = new Set<string>();
  page.on("requestfinished", (request) => {
    if (rareImages.test(request.url())) finished.add(request.url());
  });
  await page.route(/\/board-[^/]+\.png$/, async (route) => {
    await boardGate.promise;
    await route.continue();
  });
  await page.route(rareImages, async (route) => {
    requests++;
    pending++;
    maximumPending = Math.max(maximumPending, pending);
    await warmGate.promise;
    await route.continue();
    pending--;
  });
  const fixture = await mockRoom(page, playingShogiRoom(tacticalShogiState()));
  try {
    await page.goto("/rooms/12345", { waitUntil: "domcontentloaded" });
    await expect(square(page, "D4")).toBeEnabled();
    expect(requests).toBe(0);
    boardGate.resolve();
    await expect.poll(() => requests).toBe(2);
    const menu = await openPromotion(page);
    await expect(menu.getByText("成銀", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    warmGate.resolve();
    await expect.poll(() => requests).toBe(6);
    await expect.poll(() => pending).toBe(0);
    expect(maximumPending).toBe(2);
    await expect.poll(() => finished.size).toBe(6);
    const prepared = await openPromotion(page);
    await expect(prepared.locator('img[src*="up_prom_silver-"]')).toBeVisible();
    await expect(prepared.getByText("成銀", { exact: true })).toHaveCount(0);
    expect(requests).toBe(6);
    expect(fixture.received.filter((message) => message.type === "room.game.action")).toHaveLength(
      0,
    );
  } finally {
    boardGate.resolve();
    warmGate.resolve();
  }
});

test("将棋ロビー・リバーシでは成り駒と裏王を先読みしない", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (rareImages.test(request.url())) requests.push(request.url());
  });
  await mockLobby(page);
  await page.goto("/games/four-shogi");
  await page
    .getByTestId("lobby-board-preview")
    .locator("img")
    .evaluateAll((images) =>
      Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
    );
  expect(requests).toEqual([]);
  await mockRoom(page, playingRoom());
  await page.goto("/rooms/12345");
  await expect(page.getByRole("button", { name: "投了", exact: true })).toBeVisible();
  expect(requests).toEqual([]);
});

test("古い裏王のデコードが完了しても、更新された王の表示を上書きしない", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeDecode = HTMLImageElement.prototype.decode;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    Object.assign(window, { releaseKingDecode: release, kingDecodes: 0 });
    HTMLImageElement.prototype.decode = async function () {
      await nativeDecode.call(this);
      if (/up_dead_king2-/.test(this.src)) {
        (window as unknown as { kingDecodes: number }).kingDecodes++;
        await gate;
      }
    };
  });
  const state = tacticalShogiState();
  const fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345", { waitUntil: "domcontentloaded" });
  const eliminated = eliminateSide(state, "south", "resigned");
  if (!eliminated.ok) throw new Error("Invalid elimination fixture");
  fixture.update(playingShogiRoom(eliminated.state, 1));
  await expect(square(page, "E9").getByText("裏王", { exact: true })).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { kingDecodes: number }).kingDecodes > 0);
  fixture.update(playingShogiRoom(state, 2));
  await expect(square(page, "E9").locator('img[src*="up_king2-"]')).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { releaseKingDecode: () => void }).releaseKingDecode(),
  );
  await expect(square(page, "E9").getByText("裏王", { exact: true })).toHaveCount(0);
  await expect(square(page, "E9").locator('img[src*="dead_king"]')).toHaveCount(0);
  const promotion = applyAction(state, "south", {
    type: "movePiece",
    from: { x: 3, y: 3 },
    to: { x: 3, y: 2 },
    promote: true,
  });
  if (!promotion.ok) throw new Error("Invalid promotion fixture");
  fixture.update(playingShogiRoom(promotion.state, 3));
  await expect(square(page, "D3").locator('img[src*="up_prom_silver-"]')).toBeVisible();
});

for (const width of [320, 390, 768, 1440]) {
  test(`${width}px: 成銀・龍・裏王の代替表示も観戦の4方向へ回転する`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 950 });
    await page.route(rareImages, (route) => route.abort("failed"));
    const state = tacticalShogiState();
    // 表示用の固定局面。脱落の処理は公開エンジンを通します。
    const board = state.board.map((row) => row.slice());
    board[3]![3] = { ...board[3]![3]!, promoted: true };
    board[6]![2] = { ...board[6]![2]!, promoted: true };
    board[5]![4] = { ...board[5]![4]!, promoted: true };
    board[3]![5] = { id: state.nextPieceId, side: "north", kind: "rook", promoted: true };
    const first = eliminateSide(
      { ...state, board, nextPieceId: state.nextPieceId + 1 },
      "south",
      "resigned",
    );
    if (!first.ok) throw new Error("Invalid south elimination");
    const second = eliminateSide(first.state, "north", "left");
    if (!second.ok) throw new Error("Invalid north elimination");
    await mockRoom(page, playingShogiRoom(second.state), false);
    await page.goto("/rooms/12345");
    const southDirections = ["up", "right", "down", "left"] as const;
    const northDirections = ["down", "left", "up", "right"] as const;
    for (let turn = 0; turn < 4; turn++) {
      for (const [cell, label, directions] of [
        ["D4", "成銀", southDirections],
        ["C7", "龍", southDirections],
        ["E9", "裏王", southDirections],
        ["E6", "成銀", northDirections],
        ["F4", "龍", northDirections],
        ["E1", "裏王", northDirections],
      ] as const) {
        const piece = square(page, cell);
        const fallback = piece.getByText(label, { exact: true });
        await expect(fallback).toBeVisible();
        await expect(piece.getByTestId("shogi-piece")).toBeHidden();
        await expect(piece.getByTestId("shogi-piece")).toHaveAttribute(
          "data-piece-direction",
          directions[turn]!,
        );
        const expected = { up: "none", right: "90deg", down: "180deg", left: "-90deg" }[
          directions[turn]!
        ]!;
        await expect(fallback).toHaveCSS("rotate", expected);
        const box = (await fallback.boundingBox())!;
        const bounds = (await piece.boundingBox())!;
        expect(box.width).toBeGreaterThan(0);
        expect(box.width).toBeLessThanOrEqual(bounds.width + 1);
        expect(box.height).toBeLessThanOrEqual(bounds.height + 1);
      }
      await info.attach(`fallback-${turn}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.getByRole("button", { name: "盤面を時計回りに90度回転" }).click();
    }
  });
  test(`${width}px: 保存棋譜でも画像失敗時に裏王を識別できる`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.route(rareImages, (route) => route.abort("failed"));
    await mockAccount(page, profile);
    const match = shogiReplayMatch();
    await page.route(/\/api\/account\/matches\/[^/?]+$/, (route) =>
      route.fulfill({ json: { match: match.detail } }),
    );
    await page.route(/\/api\/account\/matches\/[^/?]+\/replay(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: match.page(Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0)),
      }),
    );
    await page.goto(`/account/matches/${match.detail.id}`);
    await expect(page.getByText("棋譜閲覧中", { exact: true })).toBeVisible();
    const kings = page.getByTestId("shogi-board").getByRole("button", { name: /裏王/ });
    await expect(kings).toHaveCount(3);
    for (const king of await kings.all()) {
      await expect(king.getByText("裏王", { exact: true })).toBeVisible();
      await expect(king.getByTestId("shogi-piece")).toBeHidden();
      await expect(king).toBeDisabled();
    }
  });
}

test("詰みによる脱落も、画像取得失敗時に裏王で表示する", async ({ page }) => {
  await page.route(rareImages, (route) => route.abort("failed"));
  const state = tacticalShogiState();
  const board = state.board.map((row) => row.map(() => null as (typeof row)[number]));
  let id = state.nextPieceId;
  for (const [cell, side, kind] of [
    ["E9", "south", "king"],
    ["A1", "west", "king"],
    ["I1", "north", "king"],
    ["I9", "east", "king"],
    ["E2", "south", "rook"],
    ["B3", "south", "gold"],
    ["H3", "south", "gold"],
  ] as const)
    board[Number(cell[1]) - 1]![cell.charCodeAt(0) - 65] = {
      id: id++,
      side,
      kind,
      promoted: false,
    };
  const emptyHand = { pawn: 0, silver: 0, gold: 0, rook: 0 };
  const initial = {
    ...state,
    board,
    nextPieceId: id,
    threePlayerAttackProhibited: false,
    hands: { south: emptyHand, west: emptyHand, north: emptyHand, east: emptyHand },
  };
  const fixture = await mockRoom(page, playingShogiRoom(initial), false);
  await page.goto("/rooms/12345");
  const result = applyAction(initial, "south", {
    type: "movePiece",
    from: { x: 4, y: 1 },
    to: { x: 4, y: 0 },
    promote: false,
  });
  if (!result.ok) throw new Error("Invalid checkmate fixture");
  expect(result.eliminations.filter((entry) => entry.reason === "checkmate")).toHaveLength(2);
  fixture.update(playingShogiRoom(result.state, 1));
  for (const cell of ["A1", "I1"])
    await expect(square(page, cell).getByText("裏王", { exact: true })).toBeVisible();
});
