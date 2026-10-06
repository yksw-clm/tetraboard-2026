import { expect, test, type Page, type Route } from "@playwright/test";
import { roomSchema, type Room } from "@tetraboard/protocol";
import { mockAccount, profile } from "./accountFixtures";
import { mockRoom, playerIds, playingRoom, waitingRoom } from "./fixtures";
import { playingShogiRoom, waitingShogiRoom } from "./fourShogiFixtures";

const notice = "CPUを含んだ対局は、戦績に反映されません。";
const supplement = "ランキングにも反映されません。終局した対局の履歴・棋譜は保存されます。";
const sizes = [320, 390, 768, 1440];
function singleHost(game: "four-reversi" | "four-shogi") {
  const room = game === "four-shogi" ? waitingShogiRoom() : waitingRoom();
  room.players = room.players.slice(0, 1);
  return room;
}
function withCpu(room: Room) {
  return roomSchema.parse({
    ...room,
    players: [
      ...room.players,
      {
        id: playerIds[1],
        name: "CPU Lv2",
        kind: "cpu",
        level: 2,
        ready: true,
        reconnectDeadline: null,
        ...(room.settings.game === "four-shogi" ? { side: null } : { color: null }),
      },
    ],
  });
}
async function settings(page: Page, width: number) {
  if (width < 1280) await page.getByRole("tab", { name: "ルーム", exact: true }).click();
  await page.getByRole("button", { name: "ルーム設定" }).click();
  await expect(page.getByRole("button", { name: "CPUを追加", exact: true })).toBeVisible();
}

for (const game of ["four-reversi", "four-shogi"] as const) {
  for (const width of sizes) {
    test(
      game + " CPU追加の確認・取消・直接追加・全削除後の再確認 " + width + "px",
      async ({ page }, info) => {
        await page.setViewportSize({ width, height: 850 });
        const room = singleHost(game);
        const control = await mockRoom(page, room);
        await mockAccount(page, profile);
        const additions = () =>
          control.received.filter((message) => message.type === "room.cpu.add");
        await page.goto("/rooms/12345");
        await settings(page, width);
        const add = page.getByRole("button", { name: "CPUを追加", exact: true });
        await page
          .getByRole("group", { name: "追加するCPUのレベル" })
          .getByRole("button", { name: "Lv2" })
          .click();
        const dialog = page.getByRole("dialog", { name: "CPUを追加しますか？" });
        for (const close of ["キャンセル", "閉じる", "Escape"]) {
          await add.click();
          await expect(dialog.getByText(notice, { exact: true })).toBeVisible();
          await expect(dialog.getByText(supplement, { exact: true })).toBeVisible();
          await expect(dialog).toContainText("追加するCPU：Lv2");
          expect(additions()).toEqual([]);
          if (close === "Escape") await page.keyboard.press("Escape");
          else await dialog.getByRole("button", { name: close, exact: true }).click();
          await expect(dialog).toHaveCount(0);
          await expect(add).toBeFocused();
          expect(additions()).toEqual([]);
        }
        await add.click();
        const box = await dialog.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: info.outputPath("cpu-confirmation.png") });
        // 閉じたダイアログの座標を再クリックすると背後の別操作になるため、確認の連打はEnterで行います。
        await dialog.getByRole("button", { name: "CPUを追加", exact: true }).press("Enter");
        await page.keyboard.press("Enter");
        await expect.poll(additions).toEqual([{ type: "room.cpu.add", level: 2 }]);
        await expect(dialog).toHaveCount(0);
        await expect(add).toBeDisabled();
        control.update(withCpu(room));
        await expect(add).toBeEnabled();
        await add.click();
        await expect.poll(additions).toHaveLength(2);
        await expect(dialog).toHaveCount(0);
        control.update(withCpu(room));
        await expect(add).toBeEnabled();
        await page.getByRole("button", { name: "CPU Lv2を削除" }).click();
        await expect
          .poll(() => control.received)
          .toContainEqual({
            type: "room.cpu.remove",
            playerId: playerIds[1],
          });
        control.update(room);
        await expect(add).toBeEnabled();
        await add.click();
        await expect(dialog).toBeVisible();
        expect(additions()).toHaveLength(2);
        // PC境界を越えてRoomInfoが再配置されても、未送信の確認は保持します。
        await page.setViewportSize({ width: width < 1280 ? 1440 : 390, height: 850 });
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect
          .poll(() => page.evaluate(() => document.activeElement !== document.body))
          .toBe(true);
        expect(additions()).toHaveLength(2);
      },
    );

    test(game + " ゲストはCPU0人でも直接追加 " + width + "px", async ({ page }) => {
      await page.setViewportSize({ width, height: 850 });
      const control = await mockRoom(page, singleHost(game));
      await page.goto("/rooms/12345");
      await settings(page, width);
      await page.getByRole("button", { name: "CPUを追加", exact: true }).click();
      await expect.poll(() => control.received).toContainEqual({ type: "room.cpu.add", level: 1 });
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test(
      game + " すぐ遊ぶだけログイン時に注意・ランキングの集計条件 " + width + "px",
      async ({ page }) => {
        await page.setViewportSize({ width, height: 850 });
        await mockAccount(page, profile);
        await page.goto("/games/" + game);
        await page.getByRole("button", { name: /^すぐ遊ぶ/ }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText(notice, { exact: true })).toBeVisible();
        await expect(dialog.getByText(supplement, { exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        for (const button of [/^ルームを作る/, /^ルーム番号で参加/]) {
          await page.getByRole("button", { name: button }).click();
          await expect(dialog).toBeVisible();
          await expect(dialog.getByText(notice, { exact: true })).toHaveCount(0);
          await page.keyboard.press("Escape");
        }
        const ranking = page.getByRole("region", { name: "ランキング", exact: true });
        await expect(ranking.getByText("対人戦のみ集計", { exact: true })).toBeVisible();
        await ranking.getByRole("button", { name: "もっと見る" }).click();
        await expect(dialog.getByText("対人戦のみ集計", { exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await mockAccount(page, null);
        await page.reload();
        await page.getByRole("button", { name: /^すぐ遊ぶ/ }).click();
        await expect(dialog.getByRole("textbox", { name: "ニックネーム" })).toBeVisible();
        await expect(dialog.getByText(notice, { exact: true })).toHaveCount(0);
      },
    );
  }

  test(game + " 確認中の満席・開始・ホスト喪失では追加しない", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const room = singleHost(game);
    const control = await mockRoom(page, room);
    await mockAccount(page, profile);
    await page.goto("/rooms/12345");
    await settings(page, 1440);
    for (const change of ["full", "host", "playing"]) {
      const add = page.getByRole("button", { name: "CPUを追加", exact: true });
      await expect(add).toBeEnabled();
      await add.click();
      await expect(page.getByRole("dialog", { name: "CPUを追加しますか？" })).toBeVisible();
      if (change === "full")
        control.update(game === "four-shogi" ? waitingShogiRoom() : waitingRoom());
      else if (change === "host")
        control.update(room, { hostPlayerId: playerIds[1]!, connectedPlayerIds: [playerIds[0]!] });
      else control.update(game === "four-shogi" ? playingShogiRoom() : playingRoom());
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(control.received.filter((message) => message.type === "room.cpu.add")).toEqual([]);
      control.update(room);
    }
  });

  test(
    game + " ログイン取得待ち・失敗・再試行とフォーカス復帰でも確認を省略しない",
    async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 850 });
      const control = await mockRoom(page, singleHost(game));
      let pending: Route | null = null;
      let hold = true;
      await page.route("**/api/account/session", async (route) => {
        if (hold) pending = route;
        else await route.fulfill({ json: { user: profile } });
      });
      await page.goto("/rooms/12345");
      await settings(page, 390);
      const add = page.getByRole("button", { name: "CPUを追加", exact: true });
      await expect(page.getByText("ログイン状態を確認しています…", { exact: true })).toBeVisible();
      await expect(add).toBeDisabled();
      await expect.poll(() => pending !== null).toBe(true);
      await pending!.fulfill({ status: 503, json: { message: "unavailable" } });
      await expect(page.getByRole("alert")).toContainText("ログイン状態を確認できません");
      await expect(add).toBeDisabled();
      hold = false;
      await page.getByRole("button", { name: "ログイン状態を再確認" }).click();
      await expect(add).toBeEnabled();
      expect(control.received.filter((message) => message.type === "room.cpu.add")).toEqual([]);
      await add.click();
      await expect(page.getByRole("dialog", { name: "CPUを追加しますか？" })).toBeVisible();
      hold = true;
      pending = null;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(add).toBeDisabled();
      await expect.poll(() => pending !== null).toBe(true);
      hold = false;
      await pending!.fulfill({ json: { user: profile } });
      await expect(add).toBeEnabled();
      await add.click();
      await expect(page.getByRole("dialog", { name: "CPUを追加しますか？" })).toBeVisible();
      expect(control.received.filter((message) => message.type === "room.cpu.add")).toEqual([]);
    },
  );
}

test("マイページの戦績にも対人戦のみの条件を表示する", async ({ page }) => {
  await mockAccount(page, profile);
  await page.goto("/account");
  await expect(
    page
      .getByRole("region", { name: "戦績", exact: true })
      .getByText("対人戦のみ集計", { exact: true }),
  ).toBeVisible();
});
