import { expectReplaySelectFits } from "./replaySelectAssertions";
import { expect, test } from "@playwright/test";
import { applyAction, createInitialState, eliminateColor } from "@tetraboard/four-reversi";
import { roomSchema, roomTimeControl, type ChatEntry } from "@tetraboard/protocol";
import {
  mockLobby,
  mockRoom,
  now,
  playerIds,
  playingRoom,
  token,
  waitingRoom,
  widths,
} from "./fixtures";

for (const width of widths) {
  test(`ロビー一覧の失敗・追加読込・観戦・参加 ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const room = waitingRoom();
    room.players = room.players.slice(0, 1);
    const joinedIdentity = { playerId: playerIds[1]!, role: "player" as const };
    await mockLobby(page);
    await mockRoom(page, room, false, joinedIdentity);
    let failed = true;
    const metadata = {
      id: "12345",
      game: "four-reversi",
      mode: "singles",
      timeControl: roomTimeControl,
      status: "waiting",
      hostName: "てとら",
      humanCount: 1,
      cpuCount: 0,
      capacity: 4,
      openSeats: 3,
      updatedAtMs: now,
    };
    await page.route("**/api/rooms?*", (route) =>
      route.fulfill({
        json: {
          rooms: [{ ...metadata, id: "23456", status: "playing", humanCount: 4, openSeats: 0 }],
          nextCursor: null,
        },
      }),
    );
    await page.route("**/api/rooms", (route) =>
      route.fulfill(
        failed
          ? { status: 500, json: { error: "internal_error" } }
          : { json: { rooms: [metadata], nextCursor: `${now}:12345` } },
      ),
    );
    await page.goto("/games/four-reversi");
    await expect(
      page.getByRole("region", { name: "公開ルーム" }).getByRole("status"),
    ).toContainText("更新");
    failed = false;
    const lobby = page.getByRole("region", { name: "公開ルーム" });
    await lobby.getByRole("button", { name: "更新", exact: true }).click();
    await lobby.getByRole("button", { name: "もっと見る" }).click();
    await expect(page.getByRole("button", { name: "ルーム 23456 を観戦" })).toBeVisible();
    await expect(page.getByRole("button", { name: "ルーム 23456 に参加" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const entries = page.getByRole("region", { name: "公開ルーム" }).getByRole("listitem");
    const first = await entries.nth(0).boundingBox();
    const second = await entries.nth(1).boundingBox();
    if (!first || !second) throw Error("公開ルームが表示されていません");
    if (width > 650 && width <= 900) {
      expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1);
      expect(second.x).toBeGreaterThan(first.x + first.width);
    } else {
      expect(Math.abs(first.x - second.x)).toBeLessThanOrEqual(1);
      expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1);
    }
    for (const entry of await entries.all()) {
      const box = await entry.boundingBox();
      if (!box) throw Error();
      for (const button of await entry.getByRole("button").all()) {
        const action = await button.boundingBox();
        if (!action) throw Error();
        expect(action.x).toBeGreaterThanOrEqual(box.x - 1);
        expect(action.x + action.width).toBeLessThanOrEqual(box.x + box.width + 1);
      }
      // 通常の短いモード名さえ縦に折り返されるような列幅の崩れを検出します。
      const mode = await entry.getByText("シングルス", { exact: true }).boundingBox();
      expect(mode?.height).toBeLessThanOrEqual(24);
    }
    await testInfo.attach("lobby-list", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.getByRole("button", { name: "ルーム 12345 を観戦" }).click();
    await expect(page).toHaveURL(/rooms\/12345$/);
    await expect(page.getByRole("button", { name: "参加する", exact: true })).toBeEnabled();
    await page.goto("/games/four-reversi");
    await page.getByRole("button", { name: "ルーム 12345 に参加" }).click();
    await page.getByRole("textbox", { name: "ニックネーム" }).fill("参加者");
    await page.route("**/api/rooms/12345/players", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ name: "参加者" });
      room.players.push({ ...room.players[0]!, id: playerIds[1]!, name: "参加者" });
      await route.fulfill({ json: { room, membership: { ...joinedIdentity, token } } });
    });
    await page.getByRole("dialog").getByRole("button", { name: "参加する", exact: true }).click();
    await expect(page).toHaveURL(/rooms\/12345$/);
  });
}

for (const width of [320, 900, 1440]) {
  test(`設定・招待・準備・開始・着手・退室 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // Clipboard APIの拒否というブラウザ境界から、手動コピー導線を確認します。
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
      }),
    );
    const room = waitingRoom();
    if (room.status !== "waiting") throw Error();
    room.players = room.players.slice(0, 1);
    const control = await mockRoom(page, room);
    await mockLobby(page);
    await page.goto("/rooms/12345");
    if (width < 1280) await page.getByRole("tab", { name: "ルーム", exact: true }).click();
    await page.getByRole("button", { name: "招待リンクをコピー" }).click();
    const invitation = page.getByRole("dialog");
    await expect(invitation.getByRole("textbox", { name: "招待リンク" })).toHaveValue(
      new RegExp(`/rooms/12345\\?invite=${room.instanceId}`),
    );
    await expect(invitation.getByRole("textbox")).toHaveAttribute("readonly", "");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "ルーム設定" }).click();
    await page.getByText("ダブルス", { exact: true }).click();
    await expect
      .poll(() => control.received)
      .toContainEqual({ type: "room.mode.set", mode: "doubles" });
    room.settings.mode = "doubles";
    control.update(room);
    await page
      .getByRole("group", { name: "追加するCPUのレベル" })
      .getByRole("button", { name: "Lv2" })
      .click();
    await page.getByRole("button", { name: "CPUを追加" }).click();
    await expect.poll(() => control.received).toContainEqual({ type: "room.cpu.add", level: 2 });
    room.players.push({
      id: playerIds[1]!,
      name: "CPU Lv2",
      kind: "cpu",
      level: 2,
      ready: true,
      reconnectDeadline: null,
      color: null,
    });
    control.update(room);
    await page
      .getByRole("group", { name: "CPU 1のレベル", exact: true })
      .getByRole("button", { name: "Lv1" })
      .click();
    await expect
      .poll(() => control.received)
      .toContainEqual({ type: "room.cpu.level.set", playerId: playerIds[1], level: 1 });
    if (room.players[1]!.kind === "cpu") room.players[1]!.level = 1;
    control.update(room);
    await page.getByRole("button", { name: "CPU Lv1を削除" }).click();
    await expect
      .poll(() => control.received)
      .toContainEqual({ type: "room.cpu.remove", playerId: playerIds[1] });
    const ready = waitingRoom();
    ready.players.forEach((p) => {
      p.ready = true;
    });
    ready.players[0]!.ready = false;
    control.update(ready);
    if (width < 1280) await page.getByRole("tab", { name: "盤面", exact: true }).click();
    await page.getByRole("button", { name: "準備完了", exact: true }).click();
    await expect
      .poll(() => control.received)
      .toContainEqual({ type: "room.ready.set", ready: true });
    ready.players[0]!.ready = true;
    control.update(ready);
    await page.getByRole("button", { name: "対局開始", exact: true }).click();
    await expect.poll(() => control.received).toContainEqual({ type: "room.game.start" });
    const playing = playingRoom();
    if (playing.status !== "playing") throw Error();
    control.update(playing);
    await page.getByRole("button", { name: "C4：空き、置けます", exact: true }).click();
    await expect
      .poll(() => control.received)
      .toContainEqual({
        type: "room.game.action",
        action: { type: "placeStone", position: { x: 2, y: 3 } },
      });
    const moved = applyAction(playing.game, { type: "placeStone", position: { x: 2, y: 3 } });
    if (!moved.ok || moved.state.status !== "playing") throw Error();
    control.update(roomSchema.parse({ ...playing, game: moved.state }));
    await expect(page.getByRole("button", { name: "C4：黒、直前の手", exact: true })).toBeVisible();
    if (width < 1280) await page.getByRole("tab", { name: "ルーム", exact: true }).click();
    await page.getByRole("button", { name: "退室", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "キャンセル" }).click();
    await expect(page.getByRole("button", { name: "退室", exact: true })).toBeFocused();
    await page.route("**/api/rooms/12345/leave", (route) => route.fulfill({ status: 204 }));
    await page.getByRole("button", { name: "退室", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "退室する" }).click();
    await expect(page).toHaveURL(/games\/four-reversi$/);
  });

  test(`再戦の結果・棋譜・チャットの入力とスクロール保持 ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const initial = createInitialState("doubles");
    const end = eliminateColor(initial, "black");
    if (!end.ok || end.state.status !== "finished") throw Error();
    const room = roomSchema.parse({
      ...waitingRoom(),
      settings: { game: "four-reversi", mode: "doubles", timeControl: roomTimeControl },
      lastRound: {
        game: end.state,
        players: playerIds.map((id, index) => ({
          id,
          name: `参加者${index + 1}`,
          color: ["black", "white", "red", "blue"][index],
        })),
        replay: {
          id: "00000000-0000-4000-8000-000000000099",
          initial,
          steps: [
            {
              action: { type: "eliminate", color: "black", reason: "disconnected" },
              game: end.state,
              passedColors: [],
            },
          ],
        },
      },
    });
    const control = await mockRoom(page, room);
    await page.goto("/rooms/12345");
    await page.getByRole("button", { name: "結果", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("白・青チームの勝ち");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "棋譜を1つ戻る" }).click();
    await expect(page.getByRole("button", { name: "棋譜を1つ戻る" })).toBeDisabled();
    await page.getByRole("button", { name: "棋譜を1つ進む" }).click();
    await expect(page.getByRole("button", { name: "棋譜を1つ進む" })).toBeDisabled();
    await page.getByRole("button", { name: "棋譜の局面" }).click();
    await expectReplaySelectFits(page);
    await page.getByRole("option", { name: "開始局面" }).click();
    await expect(page.getByRole("button", { name: "棋譜を1つ戻る" })).toBeDisabled();
    await expect(page.getByRole("listbox")).toBeHidden();
    await testInfo.attach("replay", { body: await page.screenshot(), contentType: "image/png" });
    if (width < 1280) await page.getByRole("tab", { name: "チャット", exact: true }).click();
    const messages: ChatEntry[] = Array.from({ length: 45 }, (_, index) => ({
      id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
      kind: "player",
      senderId: playerIds[1]!,
      senderName: "参加者2",
      text: `メッセージ ${index + 1}`,
      sentAtMs: now + index,
    }));
    control.send({ type: "room.chat.snapshot", messages });
    const log = page.getByRole("list", { name: "チャット履歴" });
    await expect(log.getByText("メッセージ 45", { exact: true })).toBeVisible();
    await log.evaluate((el) => {
      el.scrollTop = 120;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(page.getByRole("button", { name: "最新のメッセージへ" })).toBeVisible();
    const top = await log.evaluate((el) => el.scrollTop);
    const input = page.getByRole("textbox", { name: "メッセージ" });
    await input.fill("編集中");
    if (width < 1280) {
      await page.getByRole("tab", { name: "ルーム", exact: true }).click();
      await page.getByRole("tab", { name: "チャット", exact: true }).click();
    }
    await expect(input).toHaveValue("編集中");
    expect(Math.abs((await log.evaluate((el) => el.scrollTop)) - top)).toBeLessThanOrEqual(1);
    await input.fill("あ".repeat(101));
    await expect(page.getByRole("button", { name: "送信", exact: true })).toBeDisabled();
    await input.fill("送信テスト");
    await page.getByRole("button", { name: "送信", exact: true }).click();
    await expect
      .poll(() => control.received)
      .toContainEqual({ type: "room.chat.send", text: "送信テスト" });
    control.send({
      type: "room.chat.snapshot",
      messages: [
        ...messages,
        {
          ...messages[0]!,
          id: "00000000-0000-4000-9000-000000000099",
          senderId: playerIds[0],
          text: "送信テスト",
        },
      ],
    });
    await expect(input).toHaveValue("");
    await page.getByRole("button", { name: "最新のメッセージへ" }).click();
    await expect(log.getByText("送信テスト", { exact: true })).toBeInViewport();
    await testInfo.attach("chat", { body: await page.screenshot(), contentType: "image/png" });
  });
}
