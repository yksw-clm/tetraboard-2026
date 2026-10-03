import { roomTimeControl } from "@tetraboard/protocol";
import { expect, test } from "@playwright/test";
import { membership, mockLobby, mockRoom, playingRoom, token, waitingRoom } from "./fixtures";

test("作成ダイアログの入力を引き継ぎ、作成成功後に待機室へ移る", async ({ page }) => {
  await mockLobby(page);
  const room = waitingRoom();
  room.settings.mode = "doubles";
  room.players[0]!.name = "てとら";
  await mockRoom(page, room, false);
  await page.route("**/api/rooms", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    expect(route.request().postDataJSON()).toEqual({
      name: "てとら",
      quickPlay: false,
      mode: "doubles",
      timeControl: roomTimeControl,
    });
    await route.fulfill({ status: 201, json: { room, membership: { ...membership, token } } });
  });
  await page.goto("/games/four-reversi");
  const open = page.getByRole("button", { name: /^ルームを作る/ });
  await open.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "ニックネーム" }).fill("てとら");
  await dialog.getByText("ダブルス", { exact: true }).click();
  await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await open.click();
  await expect(dialog.getByRole("textbox", { name: "ニックネーム" })).toHaveValue("てとら");
  await expect(dialog.getByRole("radio", { name: "ダブルス 2対2のチーム戦" })).toBeChecked();
  await dialog.getByRole("button", { name: "ルームを作る", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms\/12345$/);
  await expect(page.getByRole("button", { name: "準備完了", exact: true })).toBeEnabled();
});

test("小さい画面でのタブ切替と回転でもチャット入力と4席の表示を保つ", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 700 });
  await mockRoom(page);
  await page.goto("/rooms/12345");
  await expect(page.getByRole("button", { name: "準備完了", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "チャット", exact: true }).click();
  await page.getByRole("textbox", { name: "メッセージ" }).fill("入力を保持");
  await page.getByRole("tab", { name: "ルーム", exact: true }).click();
  await expect(page.getByRole("button", { name: "招待リンクをコピー" })).toBeVisible();
  await page.getByRole("tab", { name: "チャット", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "メッセージ" })).toHaveValue("入力を保持");
  await page.getByRole("tab", { name: "盤面", exact: true }).click();
  for (const viewport of [
    { width: 700, height: 390 },
    { width: 768, height: 900 },
    { width: 320, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    const cards = page.getByTestId("player-card");
    for (const card of await cards.all()) await expect(card).toBeVisible();
    await expect
      .poll(() =>
        cards
          .getByTestId("player-name")
          .evaluateAll((names) =>
            names.every(
              (name) =>
                name.firstElementChild!.getBoundingClientRect().width <= name.clientWidth + 1,
            ),
          ),
      )
      .toBe(true);
  }
  expect(errors).toEqual([]);
});

test("共通ダイアログで投了を取り消し、送信中の閉鎖を防ぐ", async ({ page }) => {
  const room = await mockRoom(page, playingRoom());
  await page.goto("/rooms/12345");
  const trigger = page.getByRole("button", { name: "投了", exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "投了しますか？" })).toBeVisible();
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole("button", { name: "投了する", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  room.send({ type: "room.error", error: "not_your_turn" });
  await expect(dialog.getByRole("alert")).toHaveText("現在はあなたの手番ではありません。");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toHaveCount(0);
});

test("秒読みのアニメーションは動きを減らす設定に従う", async ({ page }) => {
  const room = playingRoom();
  if (room.status !== "playing") throw new Error("Expected playing room");
  room.clock.remainingMainMs.black = 0;
  room.clock.turnExpiresAt = room.clock.turnStartedAt + 9000;
  await mockRoom(page, room);
  await page.goto("/rooms/12345");
  const clock = page
    .getByTestId("player-card")
    .getByLabel(/^秒読み/)
    .first();
  await expect(clock).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(clock).toHaveCSS("animation-name", "room-urgency");
});
