import { expect, test } from "@playwright/test";
import { mockLobby, mockRoom, playingRoom } from "./fixtures";
import { playingShogiRoom } from "./fourShogiFixtures";

for (const game of ["four-reversi", "four-shogi"] as const) {
  test(game + " 観戦者は閉鎖通知で接続を終了しロビーへ戻れる", async ({ page }) => {
    await mockLobby(page);
    const room = game === "four-shogi" ? playingShogiRoom() : playingRoom();
    const control = await mockRoom(page, room, false);
    await page.goto("/rooms/12345");
    await expect(page.getByText("観戦中です", { exact: true })).toBeVisible();
    await expect.poll(() => control.connectedSocketCount).toBe(1);
    control.send({ type: "room.error", error: "not_found" });
    await expect(page.getByRole("alert")).toHaveText(
      "ルームは閉鎖されています。ロビーへ戻ってください。",
    );
    await expect.poll(() => control.connectedSocketCount).toBe(0);
    await page.getByRole("link", { name: "ロビーへ戻る", exact: true }).click();
    await expect(page).toHaveURL(new RegExp("/games/" + game + "$"));
  });
}
