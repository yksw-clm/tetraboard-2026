import { expect, test, type Locator } from "@playwright/test";
import { mockRoom, playerIds, playingRoom, waitingRoom, widths } from "./fixtures";

async function geometry(cards: Locator) {
  return cards.evaluateAll((elements) =>
    elements.map((card) => {
      const box = card.getBoundingClientRect();
      return ["player-avatar-slot", "player-name", "player-score-slot", "player-time-slot"].map(
        (id) => {
          const rect = card.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
          return [rect.x - box.x, rect.y - box.y, rect.width, rect.height];
        },
      );
    }),
  );
}
function expectStable(actual: number[][][], expected: number[][][]) {
  actual.forEach((card, i) =>
    card.forEach((slot, j) =>
      slot.forEach((value, k) =>
        expect(Math.abs(value - expected[i]![j]![k]!)).toBeLessThanOrEqual(1),
      ),
    ),
  );
}
async function expectContentsFit(cards: Locator) {
  await expect
    .poll(() =>
      cards.evaluateAll((elements) =>
        elements.every((card) => {
          const bounds = card.getBoundingClientRect();
          const inside = (rect: DOMRect) =>
            rect.left >= bounds.left - 1 &&
            rect.right <= bounds.right + 1 &&
            rect.top >= bounds.top - 1 &&
            rect.bottom <= bounds.bottom + 1;
          const name = card.querySelector('[data-testid="player-name"]')!;
          const text = name.firstElementChild!.getBoundingClientRect();
          const score = card.querySelector('[data-testid="player-score-slot"]')!.firstElementChild;
          const time = card.querySelector('[data-testid="player-time-slot"]')!.firstElementChild;
          return (
            inside(text) &&
            text.width <= name.clientWidth + 1 &&
            [
              ...card.querySelectorAll(
                '[data-testid="player-avatar"] svg, [aria-label="接続中"], [aria-label="切断中"]',
              ),
            ].every((el) => inside(el.getBoundingClientRect())) &&
            (!score || inside(score.getBoundingClientRect())) &&
            (!time || inside(time.getBoundingClientRect())) &&
            (!score ||
              !time ||
              score.getBoundingClientRect().right <= time.getBoundingClientRect().left + 1)
          );
        }),
      ),
    )
    .toBe(true);
  const sizes = await cards.evaluateAll((els) =>
    els.map((el) => ({
      w: el.getBoundingClientRect().width,
      h: el.getBoundingClientRect().height,
    })),
  );
  for (const size of sizes) {
    expect(Math.abs(size.w - sizes[0]!.w)).toBeLessThanOrEqual(1);
    expect(size.h).toBe(60);
  }
}

for (const width of widths) {
  test(`4席の固定領域と全脱落理由・接続状態 ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const control = await mockRoom(page);
    await page.goto("/rooms/12345");
    const cards = page.getByTestId("player-card");
    await expect(cards).toHaveCount(4);
    for (const avatar of await cards.getByTestId("player-avatar").all()) {
      const box = await avatar.boundingBox();
      expect(box?.width).toBe(width <= 767 ? 26 : 32);
      expect(box?.height).toBe(width <= 767 ? 26 : 32);
    }
    const initial = await geometry(cards);
    const ready = waitingRoom();
    ready.players.forEach((p) => {
      p.ready = true;
    });
    control.update(ready);
    await expect(page.getByRole("button", { name: "準備取消", exact: true })).toBeEnabled();
    expectStable(await geometry(cards), initial);
    await expectContentsFit(cards);
    const playing = playingRoom();
    if (playing.status !== "playing") throw new Error("Expected playing fixture");
    // 10文字＋王冠・2桁の石数・最長の脱落理由を同時に表示します。
    playing.game.board[0] = Array(8).fill("black");
    playing.game.turn = "white";
    control.update(playing);
    await expect(cards.getByLabel("黒、10石", { exact: true })).toBeVisible();
    expectStable(await geometry(cards), initial);
    const stoneBefore = await cards.getByTestId("player-stone-count").first().boundingBox();
    for (const [reason, label] of [
      ["resigned", "投了"],
      ["left", "退室"],
      ["timeout", "時間切れ"],
      ["disconnected", "通信切れ"],
    ] as const) {
      const state = structuredClone(playing);
      state.game.eliminatedColors = ["black"];
      state.eliminations = [{ color: "black", reason }];
      control.update(state, {
        hostPlayerId: playerIds[0]!,
        connectedPlayerIds: playerIds.slice(1),
      });
      await expect(cards.getByText(`4位（${label}）`, { exact: true })).toBeVisible();
      expectStable(await geometry(cards), initial);
      const stoneAfter = (await cards.getByTestId("player-stone-count").first().boundingBox())!;
      for (const key of ["x", "y", "width", "height"] as const)
        expect(Math.abs(stoneAfter[key] - stoneBefore![key])).toBeLessThanOrEqual(1);
      await expectContentsFit(cards);
    }
    await testInfo.attach("eliminated-cards", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    const mixed = waitingRoom();
    if (mixed.status !== "waiting") throw new Error("Expected waiting fixture");
    mixed.players = [
      mixed.players[0]!,
      {
        id: mixed.players[1]!.id,
        name: mixed.players[1]!.name,
        color: null,
        kind: "cpu",
        level: 2,
        ready: true,
        reconnectDeadline: null,
      },
    ];
    control.update(mixed, { hostPlayerId: playerIds[1]!, connectedPlayerIds: [playerIds[1]!] });
    await expect(cards.getByText("空席", { exact: true })).toHaveCount(2);
    await expect(cards.getByTitle("ホスト")).toHaveCount(1);
    await expect(cards.getByTitle("CPU")).toHaveCount(1);
    expectStable(await geometry(cards), initial);
    await expectContentsFit(cards);
  });
}
