import { roomSchema } from "@tetraboard/protocol";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockLobby, mockRoom, waitingRoom, playingRoom, membership } from "./fixtures";
import { waitingShogiRoom, playingShogiRoom } from "./fourShogiFixtures";

async function selectTime(page: Page, container: Locator, label: string, value: string) {
  await container.getByRole("button", { name: new RegExp(`${label}$`) }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}

for (const game of ["four-reversi", "four-shogi"] as const) {
  for (const width of [320, 1440]) {
    test(`${game} 作成とすぐ遊ぶで時間を選び、両方なしを防ぐ ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await mockLobby(page);
      const submitted: Record<string, unknown>[] = [];
      await page.route(/\/api\/rooms$/, (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        submitted.push(route.request().postDataJSON());
        return route.fulfill({ status: 503, json: { error: "internal_error" } });
      });
      await page.goto(`/games/${game}`);
      await page.getByRole("button", { name: /^ルームを作る/ }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "ニックネーム" }).fill("時計テスト");
      await expect(dialog.getByRole("button", { name: /持ち時間$/ })).toContainText("5分");
      await expect(dialog.getByRole("button", { name: /秒読み$/ })).toContainText("30秒");
      await selectTime(page, dialog, "持ち時間", "なし");
      await dialog.getByRole("button", { name: /秒読み$/ }).click();
      await expect(page.getByRole("option", { name: "なし", exact: true })).toBeDisabled();
      await page.getByRole("option", { name: "10秒", exact: true }).click();
      await dialog.getByRole("textbox", { name: "ニックネーム" }).press("Enter");
      await expect(dialog.getByRole("alert")).toBeVisible();
      expect(submitted.at(-1)?.timeControl).toEqual({ mainTimeMs: 0, byoyomiMs: 10_000 });
      await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
      await page.getByRole("button", { name: /^すぐ遊ぶ/ }).click();
      await expect(dialog.getByRole("button", { name: /持ち時間$/ })).toContainText("なし");
      await expect(dialog.getByRole("button", { name: /秒読み$/ })).toContainText("10秒");
      await selectTime(page, dialog, "持ち時間", "1分");
      await selectTime(page, dialog, "秒読み", "なし");
      const main = dialog.getByRole("button", { name: /持ち時間$/ });
      await main.focus();
      await main.press("Enter");
      await expect(page.getByRole("option", { name: "なし", exact: true })).toBeDisabled();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await expect(main).toContainText("10分");
      await dialog.getByRole("textbox", { name: "ニックネーム" }).press("Enter");
      await expect.poll(() => submitted.length).toBe(2);
      expect(submitted.at(-1)).toMatchObject({
        quickPlay: true,
        timeControl: { mainTimeMs: 600_000, byoyomiMs: 0 },
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await info.attach("time-control-dialog", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
      await page
        .getByRole("link", {
          name: game === "four-reversi" ? "四人将棋" : "四人リバーシ",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", {
          name: game === "four-reversi" ? "四人将棋" : "四人リバーシ",
          exact: true,
        }),
      ).toBeVisible();
      await page.getByRole("button", { name: /^ルームを作る/ }).click();
      await expect(dialog.getByRole("button", { name: /持ち時間$/ })).toContainText("5分");
    });

    test(`${game} 待機室の時間設定は応答待ちで無効になり、再読み込みとカードへ反映する ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      const room = game === "four-reversi" ? waitingRoom() : waitingShogiRoom();
      await mockLobby(page);
      const mock = await mockRoom(page, room);
      await page.goto("/rooms/12345");
      if (width === 320) await page.getByRole("tab", { name: "ルーム", exact: true }).click();
      await page.getByRole("button", { name: "ルーム設定" }).click();
      await selectTime(page, page.locator("main"), "持ち時間", "なし");
      await expect
        .poll(() => mock.received.some((m) => m.type === "room.time-control.set"))
        .toBe(true);
      expect(mock.received.at(-1)).toEqual({
        type: "room.time-control.set",
        timeControl: { mainTimeMs: 0, byoyomiMs: 30_000 },
      });
      const main = page.getByRole("button", { name: /持ち時間$/ });
      await expect(main).toBeDisabled();
      const updatedRoom = roomSchema.parse({
        ...room,
        settings: { ...room.settings, timeControl: { mainTimeMs: 0, byoyomiMs: 30_000 } },
      });
      mock.update(updatedRoom);
      await expect(main).toBeEnabled();
      await expect(main).toContainText("なし");
      await info.attach("time-control-room", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.reload();
      if (width === 320) await page.getByRole("tab", { name: "ルーム", exact: true }).click();
      await expect(page.locator("dl").getByText("なし", { exact: true })).toBeVisible();
      if (width === 320) await page.getByRole("tab", { name: "盤面", exact: true }).click();
      await expect(page.getByLabel("秒読み 00:30", { exact: true }).first()).toBeVisible();
    });
  }
  test(`${game} 一般参加者は時間を変更できない`, async ({ page }) => {
    const waiting = game === "four-reversi" ? waitingRoom() : waitingShogiRoom();
    await mockLobby(page);
    await mockRoom(page, waiting, true, { ...membership, role: "player" });
    await page.goto("/rooms/12345");
    await expect(page.getByRole("button", { name: "ルーム設定" })).toHaveCount(0);
  });
  test(`${game} 対局中のホストにも時間設定操作を表示しない`, async ({ page }) => {
    const playing = game === "four-reversi" ? playingRoom() : playingShogiRoom();
    await mockLobby(page);
    await mockRoom(page, playing);
    await page.goto("/rooms/12345");
    await expect(page.getByRole("button", { name: "ルーム設定" })).toHaveCount(0);
  });
}
