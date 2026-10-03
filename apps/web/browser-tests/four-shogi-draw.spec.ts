import { expect, test, type Page } from "@playwright/test";
import {
  applyAction,
  getLegalActions,
  setDrawProposal,
  sides,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import {
  fourShogiMatchDetailSchema,
  type FourShogiReplayEvent,
  type FourShogiLastRound,
} from "@tetraboard/protocol";
import { mockRoom, playerIds } from "./fixtures";
import { mockAccount, profile } from "./accountFixtures";
import {
  initialShogiState,
  playingShogiRoom,
  publicShogiState,
  shogiRoundId,
  waitingShogiRoom,
} from "./fourShogiFixtures";
import { expectShogiLayoutFits } from "./shogiLayoutAssertions";

function drawFixture() {
  let state: FourShogiState = initialShogiState();
  const initial = {
    mode: state.mode,
    players: state.players,
    threePlayerAttackProhibited: state.threePlayerAttackProhibited,
  };
  const events: { index: number; event: FourShogiReplayEvent }[] = [];
  for (const side of sides) {
    for (const proposed of side === "south" ? [true, false, true] : [true]) {
      const result = setDrawProposal(state, side, proposed);
      if (!result.ok) throw new Error(result.reason);
      state = result.state;
      events.push({ index: events.length, event: { type: "drawProposal", side, proposed } });
    }
    if (state.status === "playing") {
      const action = getLegalActions(state)[0]!;
      const moved = applyAction(state, side, action);
      if (!moved.ok) throw new Error(moved.reason);
      state = moved.state;
      events.push({ index: events.length, event: { type: "action", side, action } });
    }
  }
  const game = publicShogiState(state);
  if (game.status !== "finished") throw new Error("Expected draw");
  const room = waitingShogiRoom();
  const lastRound: FourShogiLastRound = {
    roundId: shogiRoundId,
    game,
    eventCount: events.length,
    players: sides.map((side, i) => ({ id: playerIds[i]!, side, name: room.players[i]!.name })),
  };
  const detail = fourShogiMatchDetailSchema.parse({
    id: shogiRoundId,
    roomId: room.id,
    startedAtMs: 1700000000000,
    endedAtMs: 1700000001000,
    settings: room.settings,
    participants: sides.map((side, seat) => ({
      id: playerIds[seat]!,
      side,
      seat,
      name: "あいうえおかきくけこ",
      kind: "human",
      avatarUrl: null,
    })),
    selfPlayerId: playerIds[0],
    game,
    knockouts: { south: 0, west: 0, north: 0, east: 0 },
    replay: { rulesVersion: 1, initial, eventCount: events.length },
  });
  return { initial, events, lastRound, detail };
}

async function selectFrame(page: Page, label: string) {
  await page.getByRole("button", { name: /棋譜の局面$/ }).click();
  await page.getByRole("option", { name: new RegExp(`${label}$`) }).click();
}

for (const width of [320, 390, 768, 1279, 1280, 1440]) {
  test(`${width}px: 投了の右隣で提案・取消を操作し、方角の右にバッジを表示する`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 950 });
    const state = initialShogiState();
    const room = playingShogiRoom(state);
    room.players = room.players.map((player) => ({ ...player, name: "あいうえおかきくけこ" }));
    const fixture = await mockRoom(page, room);
    await page.goto("/rooms/12345");
    const offer = page.getByRole("button", { name: "引分提案", exact: true });
    const resign = page.getByRole("button", { name: "投了", exact: true });
    await expect(offer).toBeEnabled();
    const a = (await resign.boundingBox())!,
      b = (await offer.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(a.x + a.width);
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
    await offer.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(
        () => fixture.received.filter((message) => message.type === "room.game.draw.set").length,
      )
      .toBe(1);
    expect(fixture.received.at(-1)).toEqual({
      type: "room.game.draw.set",
      proposed: true,
      roundId: room.roundId,
      positionRevision: 0,
    });
    await expect(offer).toBeDisabled();
    await expect(resign).toBeDisabled();
    await expect(page.getByTestId("player-card").getByText("引分", { exact: true })).toHaveCount(0);
    const proposed = setDrawProposal(state, "south", true);
    if (!proposed.ok) throw new Error(proposed.reason);
    const offered = playingShogiRoom(proposed.state, 1);
    offered.players = room.players;
    fixture.update(offered);
    const cancel = page.getByRole("button", { name: "引分取消", exact: true });
    await expect(cancel).toBeEnabled();
    await expect(
      page
        .getByLabel("担当方向 南、引分提案中", { exact: true })
        .getByText("引分", { exact: true }),
    ).toBeVisible();
    await expectShogiLayoutFits(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await info.attach(`draw-${width}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.reload();
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await expect
      .poll(
        () => fixture.received.filter((message) => message.type === "room.game.draw.set").length,
      )
      .toBe(2);
    expect(fixture.received.at(-1)).toMatchObject({ proposed: false, positionRevision: 1 });
    fixture.update({ ...room, positionRevision: 2 });
    await expect(offer).toBeEnabled();
    await expect(page.getByTestId("player-card").getByText("引分", { exact: true })).toHaveCount(0);
  });
}

test("拒否・切断で送信待ちを解除し、提案状態を再接続で復元する", async ({ page }) => {
  const room = playingShogiRoom();
  const fixture = await mockRoom(page, room);
  await page.goto("/rooms/12345");
  const offer = page.getByRole("button", { name: "引分提案", exact: true });
  await expect(offer).toBeEnabled();
  await offer.click();
  await expect(offer).toBeDisabled();
  fixture.send({ type: "room.error", error: "stale_position" });
  await expect(offer).toBeEnabled();
  await offer.click();
  await expect(offer).toBeDisabled();
  fixture.disconnect();
  const offered = playingShogiRoom({ ...initialShogiState(), drawProposals: ["south"] }, 1);
  fixture.update(offered);
  fixture.reconnect();
  await expect(page.getByRole("button", { name: "引分取消", exact: true })).toBeEnabled();
  await expect(page.getByLabel("担当方向 南、引分提案中", { exact: true })).toBeVisible();
});

for (const variant of ["observer", "eliminated", "other-turn"] as const) {
  test(`${variant}: 提案操作を表示しない`, async ({ page }) => {
    const state: FourShogiState =
      variant === "eliminated"
        ? {
            ...initialShogiState(),
            turn: "west",
            eliminations: [{ side: "south", reason: "timeout", group: 1, rank: 4 }],
          }
        : { ...initialShogiState(), turn: "west", drawProposals: ["west"] };
    await mockRoom(page, playingShogiRoom(state), variant !== "observer");
    await page.goto("/rooms/12345");
    await expect(page.getByTestId("shogi-board")).toBeVisible();
    await expect(page.getByRole("button", { name: /^引分(提案|取消)$/ })).toHaveCount(0);
    if (variant === "observer")
      await expect(page.getByLabel("担当方向 西、引分提案中", { exact: true })).toBeVisible();
  });
}

test("終局は合意引き分けの結果と再戦待機を表示する", async ({ page }) => {
  const draw = drawFixture();
  const room = waitingShogiRoom();
  room.lastRound = draw.lastRound;
  const fixture = await mockRoom(page, room);
  await page.route("**/api/rooms/12345/rounds/*/replay?*", (route) =>
    route.fulfill({
      json: {
        instanceId: room.instanceId,
        roundId: shogiRoundId,
        rulesVersion: 1,
        initial: draw.initial,
        eventCount: draw.events.length,
        events: draw.events,
        nextCursor: null,
      },
    }),
  );
  await page.goto("/rooms/12345");
  await expect(page.getByRole("button", { name: "準備完了", exact: true })).toBeEnabled();
  await expect(page.getByTestId("player-card").getByText("引分", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "結果", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("全員の合意による引き分け");
  expect(fixture.received.some((message) => message.type === "room.game.draw.set")).toBe(false);
});

for (const width of [320, 390, 768, 1279, 1280, 1440]) {
  test(`${width}px: 保存棋譜で提案・取消・最終合意のバッジを局面に合わせる`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    const fixture = drawFixture();
    await mockAccount(page, profile);
    await page.route(/\/api\/account\/matches\/[^/?]+$/, (route) =>
      route.fulfill({ json: { match: fixture.detail } }),
    );
    await page.route(/\/api\/account\/matches\/[^/?]+\/replay(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          matchId: shogiRoundId,
          rulesVersion: 1,
          initial: fixture.initial,
          eventCount: fixture.events.length,
          events: fixture.events,
          nextCursor: null,
        },
      }),
    );
    await page.goto(`/account/matches/${shogiRoundId}`);
    await expect(page.getByTestId("player-card").getByText("引分", { exact: true })).toHaveCount(4);
    await expectShogiLayoutFits(page);
    await selectFrame(page, "開始局面");
    await expect(page.getByTestId("player-card").getByText("引分", { exact: true })).toHaveCount(0);
    // 同じ「南 引分提案」が2件あるため、矢印で最初の提案・取消へ進みます。
    await page.getByRole("button", { name: "棋譜を1つ進む", exact: true }).click();
    await expect(page.getByTestId("player-card").getByText("引分", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "棋譜を1つ進む", exact: true }).click();
    await expect(page.getByTestId("player-card").getByText("引分", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^引分(提案|取消)$/ })).toHaveCount(0);
  });
}
