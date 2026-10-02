import { expect, test, type Page } from "@playwright/test";
import { mockLobby, mockRoom, waitingRoom } from "./fixtures";

async function expectDialogGeometry(page: Page) {
  const dialog = page.getByRole("dialog");
  const close = dialog.getByRole("button", { name: "閉じる", exact: true });
  await expect(close).toBeVisible();
  await expect.poll(async () => (await close.boundingBox())?.width).toBe(44);
  const bounds = (await dialog.boundingBox())!;
  const button = (await close.boundingBox())!;
  expect(button.height).toBe(44);
  expect(Math.abs(bounds.x + bounds.width - button.x - button.width - 12)).toBeLessThanOrEqual(1);
  expect(Math.abs(button.y - bounds.y - 12)).toBeLessThanOrEqual(1);
  await expect(page.locator("#root")).toHaveCSS("filter", "blur(3px)");
}

for (const width of [320, 390, 768, 1440]) {
  test(`ロビーのダイアログで入力・フォーカス・送信中の閉鎖防止 ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockLobby(page);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await page.route("**/api/rooms", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await pending;
      await route.fulfill({ status: 429, json: { error: "rate_limited" } });
    });
    await page.goto("/games/four-reversi");
    const trigger = page.getByRole("button", { name: /^すぐ遊ぶ/ });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expectDialogGeometry(page);
    await expect(dialog.getByRole("button", { name: "CPUとの待機室へ" })).toHaveCSS(
      "background-color",
      "rgb(39, 132, 85)",
    );
    await expect(dialog.getByRole("textbox", { name: "ニックネーム" })).toBeFocused();
    await testInfo.attach("lobby-dialog", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByRole("textbox", { name: "ニックネーム" }).fill("てとら");
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press("Tab");
      await expect
        .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true);
    }
    await dialog.getByRole("button", { name: "CPUとの待機室へ" }).click();
    await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.mouse.click(2, 2);
    await expect(dialog).toBeVisible();
    finish();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await page.setViewportSize({ width, height: 360 });
    await dialog.getByRole("button", { name: "CPUとの待機室へ" }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "CPUとの待機室へ" })).toBeInViewport();
    await dialog.getByRole("button", { name: "CPUとの待機室へ" }).focus();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test(`ルームの参加ダイアログから観戦へ戻る ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const room = waitingRoom();
    room.players = room.players.slice(0, 1);
    await mockRoom(page, room, false);
    await page.goto(`/rooms/${room.id}?invite=${room.instanceId}`);
    const dialog = page.getByRole("dialog");
    await expectDialogGeometry(page);
    await expect(dialog.getByRole("button", { name: "参加する", exact: true })).toHaveCSS(
      "background-color",
      "rgb(39, 132, 85)",
    );
    await expect(dialog.getByRole("textbox", { name: "ニックネーム" })).toBeFocused();
    await testInfo.attach("room-dialog", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await dialog.getByRole("button", { name: "観戦する" }).click();
    await expect(dialog).toHaveCount(0);
    const join = page.getByRole("button", { name: "参加する", exact: true });
    await expect(join).toBeFocused();
    await join.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(join).toBeFocused();
  });
}
