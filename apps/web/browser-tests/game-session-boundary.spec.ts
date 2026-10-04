import { roomSchema, fourReversiRoomSchema } from "@tetraboard/protocol";
import { expect, test } from "@playwright/test";
import {
  applyAction,
  eliminateColor,
  getLegalMoves,
  type FourReversiState,
} from "@tetraboard/four-reversi";
import { eliminateSide, setDrawProposal } from "@tetraboard/four-shogi";
import { mockRoom, playingRoom, waitingRoom, playerIds } from "./fixtures";
import { replayMatch } from "./matchReplayFixtures";
import { shogiReplayMatch } from "./fourShogiRecordFixtures";
import { initialShogiState, playingShogiRoom, waitingShogiRoom } from "./fourShogiFixtures";

for (const game of ["four-reversi", "four-shogi"] as const) {
  const shogi = game === "four-shogi";
  test(`${game}: 開始待ちは待機スナップショットで解除せず対局開始で解除する`, async ({ page }) => {
    const room = shogi ? waitingShogiRoom() : waitingRoom();
    for (const player of room.players) player.ready = true;
    const fixture = await mockRoom(page, room);
    await page.goto("/rooms/12345");
    const start = page.getByRole("button", { name: "対局開始", exact: true });
    await expect(start).toBeEnabled();
    await start.click();
    await expect
      .poll(() => fixture.received.filter((message) => message.type === "room.game.start").length)
      .toBe(1);
    await expect(start).toBeDisabled();
    fixture.update(
      roomSchema.parse({
        ...room,
        players: room.players.map((player, index) => ({
          ...player,
          name: index === 1 ? "開始待ち更新" : player.name,
        })),
      }),
    );
    await expect(
      page.getByTestId("player-card").getByText("開始待ち更新", { exact: true }),
    ).toBeVisible();
    await expect(start).toBeDisabled();
    fixture.update(shogi ? playingShogiRoom() : playingRoom());
    await expect(page.getByRole("button", { name: "投了", exact: true })).toBeEnabled();
    if (!shogi)
      await expect(page.getByRole("button", { name: /^引分(提案|取消)$/ })).toHaveCount(0);
  });

  test(`${game}: 同じ局面とpresence更新では着手待ちを保持し、進行後に操作可能に戻る`, async ({
    page,
  }) => {
    const room = shogi ? playingShogiRoom() : playingRoom();
    const fixture = await mockRoom(page, room);
    await page.goto("/rooms/12345");
    const board = page.getByRole("group", {
      name: shogi ? "四人将棋の盤面" : "四人リバーシの盤面",
      exact: true,
    });
    if (shogi) {
      await board.locator('[data-square="E7"]').click();
      await board.locator('[data-square="E6"]').click();
    } else await board.getByRole("button", { name: /C4/ }).click();
    await expect
      .poll(() => fixture.received.filter((message) => message.type === "room.game.action").length)
      .toBe(1);
    await expect(page.getByRole("button", { name: "投了", exact: true })).toBeDisabled();
    fixture.update(room, {
      hostPlayerId: playerIds[0]!,
      connectedPlayerIds: [playerIds[0]!, playerIds[2]!, playerIds[3]!],
    });
    await expect(
      page
        .getByTestId("player-card")
        .filter({ hasText: "参加者2" })
        .getByLabel("切断中", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "投了", exact: true })).toBeDisabled();
    if (shogi) fixture.update(playingShogiRoom(initialShogiState(), 1));
    else {
      const initial = playingRoom();
      if (initial.status !== "playing") throw new Error("Expected playing fixture");
      let state: FourReversiState = initial.game;
      for (let step = 0; step < 4; step++) {
        const result = applyAction(state, {
          type: "placeStone",
          position: getLegalMoves(state)[0]!,
        });
        if (!result.ok) throw new Error("Invalid fixture move");
        state = result.state;
      }
      fixture.update(fourReversiRoomSchema.parse({ ...initial, game: state }));
    }
    await expect(page.getByRole("button", { name: "投了", exact: true })).toBeEnabled();
    expect(fixture.received.filter((message) => message.type === "room.game.action")).toHaveLength(
      1,
    );
  });

  test(`${game}: 他人の脱落では投了待ちを保持し、本人の脱落でダイアログが閉じる`, async ({
    page,
  }) => {
    const room = shogi ? playingShogiRoom() : playingRoom();
    const fixture = await mockRoom(page, room);
    await page.goto("/rooms/12345");
    await page.getByRole("button", { name: "投了", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "投了する", exact: true }).click();
    const close = dialog.getByRole("button", { name: "閉じる", exact: true });
    await expect(close).toBeDisabled();
    if (shogi) {
      const other = eliminateSide(initialShogiState(), "west", "left");
      if (!other.ok) throw new Error("Invalid fixture elimination");
      fixture.update(playingShogiRoom(other.state, 1));
      await expect(
        page
          .getByTestId("player-card")
          .filter({ hasText: "参加者2" })
          .getByText("4位（退室）", { exact: true }),
      ).toBeVisible();
      await expect(close).toBeDisabled();
      const self = eliminateSide(other.state, "south", "resigned");
      if (!self.ok) throw new Error("Invalid fixture elimination");
      fixture.update(playingShogiRoom(self.state, 2));
    } else {
      const initial = playingRoom();
      if (initial.status !== "playing") throw new Error("Expected playing fixture");
      const other = eliminateColor(initial.game, "white");
      if (!other.ok) throw new Error("Invalid fixture elimination");
      fixture.update(
        fourReversiRoomSchema.parse({
          ...initial,
          game: other.state,
          eliminations: [{ color: "white", reason: "left" }],
        }),
      );
      await expect(
        page
          .getByTestId("player-card")
          .filter({ hasText: "参加者2" })
          .getByText("4位（退室）", { exact: true }),
      ).toBeVisible();
      await expect(close).toBeDisabled();
      const self = eliminateColor(other.state, "black");
      if (!self.ok) throw new Error("Invalid fixture elimination");
      fixture.update(
        fourReversiRoomSchema.parse({
          ...initial,
          game: self.state,
          eliminations: [
            { color: "white", reason: "left" },
            { color: "black", reason: "resigned" },
          ],
        }),
      );
    }
    await expect(dialog).toHaveCount(0);
    expect(fixture.received.filter((message) => message.type === "room.game.resign")).toHaveLength(
      1,
    );
  });
}

test("将棋: 同revisionの接続更新では提案待ちを保持し、状態反映・新局で解除する", async ({
  page,
}) => {
  const room = playingShogiRoom();
  const fixture = await mockRoom(page, room);
  await page.goto("/rooms/12345");
  const offer = page.getByRole("button", { name: "引分提案", exact: true });
  await expect(offer).toBeEnabled();
  await offer.click();
  await expect(offer).toBeDisabled();
  fixture.update(room, {
    hostPlayerId: playerIds[0]!,
    connectedPlayerIds: [playerIds[0]!, playerIds[2]!, playerIds[3]!],
  });
  await expect(
    page
      .getByTestId("player-card")
      .filter({ hasText: "参加者2" })
      .getByLabel("切断中", { exact: true }),
  ).toBeVisible();
  await expect(offer).toBeDisabled();
  const offered = setDrawProposal(initialShogiState(), "south", true);
  if (!offered.ok) throw new Error("Invalid fixture proposal");
  fixture.update(playingShogiRoom(offered.state, 0));
  const cancel = page.getByRole("button", { name: "引分取消", exact: true });
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(cancel).toBeDisabled();
  fixture.update(playingShogiRoom(initialShogiState(), 0));
  await expect(offer).toBeEnabled();
  await offer.click();
  await expect(offer).toBeDisabled();
  fixture.update({ ...playingShogiRoom(), roundId: "00000000-0000-4000-8000-000000000021" });
  await expect(offer).toBeEnabled();
  expect(fixture.received.filter((message) => message.type === "room.game.draw.set")).toHaveLength(
    3,
  );
});

for (const game of ["four-reversi", "four-shogi"] as const) {
  const operations =
    game === "four-shogi" ? (["move", "resign", "draw"] as const) : (["move", "resign"] as const);
  for (const operation of operations) {
    test(`${game}: ${operation}待ちは終局後の再戦待機で解除する`, async ({ page }) => {
      const shogi = game === "four-shogi";
      const fixture = await mockRoom(page, shogi ? playingShogiRoom() : playingRoom());
      await page.goto("/rooms/12345");
      if (operation === "resign") {
        await page.getByRole("button", { name: "投了", exact: true }).click();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "投了する", exact: true })
          .click();
      } else if (operation === "draw") {
        await page.getByRole("button", { name: "引分提案", exact: true }).click();
      } else if (shogi) {
        await page.locator('[data-square="E7"]').click();
        await page.locator('[data-square="E6"]').click();
      } else
        await page
          .getByRole("group", { name: "四人リバーシの盤面", exact: true })
          .getByRole("button", { name: /C4/ })
          .click();
      await expect
        .poll(
          () =>
            fixture.received.filter(
              (message) =>
                message.type ===
                (operation === "move"
                  ? "room.game.action"
                  : operation === "draw"
                    ? "room.game.draw.set"
                    : "room.game.resign"),
            ).length,
        )
        .toBe(1);
      if (shogi) {
        const match = shogiReplayMatch();
        const waiting = waitingShogiRoom();
        waiting.lastRound = {
          game: match.detail.game,
          roundId: match.detail.id,
          eventCount: match.events.length,
          players: match.detail.participants.map(({ id, name, side }) => ({ id, name, side })),
        };
        await page.route("**/api/rooms/12345/rounds/*/replay?*", (route) => {
          const { matchId: _matchId, ...chunk } = match.page(
            Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0),
          );
          return route.fulfill({
            json: { ...chunk, roundId: match.detail.id, instanceId: waiting.instanceId },
          });
        });
        fixture.update(waiting);
      } else {
        const match = replayMatch();
        const waiting = waitingRoom();
        waiting.lastRound = {
          game: match.game,
          replay: match.replay,
          players: match.participants.map(({ id, name, color }) => ({ id, name, color })),
        };
        fixture.update(waiting);
      }
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "準備完了", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: /^引分(提案|取消)$/ })).toHaveCount(0);
    });
  }
}

test("将棋: 着手待ちは同revisionの新局で解除する", async ({ page }) => {
  const fixture = await mockRoom(page, playingShogiRoom());
  await page.goto("/rooms/12345");
  await page.locator('[data-square="E7"]').click();
  await page.locator('[data-square="E6"]').click();
  await expect(page.getByRole("button", { name: "投了", exact: true })).toBeDisabled();
  fixture.update({ ...playingShogiRoom(), roundId: "00000000-0000-4000-8000-000000000021" });
  await expect(page.getByRole("button", { name: "投了", exact: true })).toBeEnabled();
  expect(fixture.received.filter((message) => message.type === "room.auth")).toHaveLength(1);
});

for (const role of ["host", "player", "observer"] as const) {
  test(`将棋: 三人攻撃禁止設定の${role}権限と配信`, async ({ page }) => {
    const room = waitingShogiRoom();
    for (const player of room.players) player.ready = true;
    const fixture = await mockRoom(page, room, role !== "observer", {
      playerId: role === "player" ? playerIds[1]! : playerIds[0]!,
      role: role === "host" ? "host" : "player",
    });
    await page.goto("/rooms/12345");
    await expect(page.getByText("三人攻撃禁止：ON", { exact: true })).toBeVisible();
    const settings = page.getByRole("button", { name: "ルーム設定", exact: true });
    if (role !== "host") {
      await expect(settings).toHaveCount(0);
      expect(
        fixture.received.filter((message) => message.type === "room.three-player-attack.set"),
      ).toHaveLength(0);
      return;
    }
    await expect(page.getByRole("button", { name: "対局開始", exact: true })).toBeEnabled();
    await settings.click();
    const off = page.getByRole("radio", { name: "OFF", exact: true });
    await off.focus();
    await page.keyboard.press("Space");
    await expect
      .poll(() =>
        fixture.received.filter((message) => message.type === "room.three-player-attack.set"),
      )
      .toEqual([{ type: "room.three-player-attack.set", prohibited: false }]);
    await expect(off).toBeDisabled();
    await expect(page.getByText("三人攻撃禁止：ON", { exact: true })).toBeVisible();
    fixture.update({
      ...room,
      settings: { ...room.settings, threePlayerAttackProhibited: false },
      players: room.players.map((player) =>
        player.kind === "human" ? { ...player, ready: false } : player,
      ),
    });
    await expect(page.getByText("三人攻撃禁止：OFF", { exact: true })).toBeVisible();
    await expect(off).toBeChecked();
    await expect(off).toBeEnabled();
    await expect(page.getByRole("button", { name: "対局開始", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "準備完了", exact: true })).toBeEnabled();
    expect(fixture.received.filter((message) => message.type === "room.auth")).toHaveLength(1);
  });
}
