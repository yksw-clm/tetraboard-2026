import { expect, test } from "@playwright/test";
import { roomSchema } from "@tetraboard/protocol";
import { mockLobby, mockRoom, playerIds, playingRoom, token, waitingRoom } from "./fixtures";
import { playingShogiRoom, waitingShogiRoom } from "./fourShogiFixtures";

for (const [game, createRoom, createPlayingRoom] of [
  ["リバーシ", waitingRoom, playingRoom],
  ["将棋", waitingShogiRoom, playingShogiRoom],
] as const) {
  for (const [closeWith, width] of [
    ["観戦する", 390],
    ["閉じる", 1440],
    ["Escape", 768],
  ] as const) {
    test(`${game}の招待を${closeWith}で閉じ、再読み込み後に手動で参加する`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const room = createRoom();
      room.players = room.players.slice(0, 1);
      const identity = { playerId: playerIds[1]!, role: "player" as const };
      const fixture = await mockRoom(page, room, false, identity);
      let sent: unknown;
      await page.route("**/api/rooms/12345/players", async (route) => {
        sent = route.request().postDataJSON();
        const next = roomSchema.parse({
          ...room,
          players: [
            ...room.players,
            { ...room.players[0], id: identity.playerId, name: "観戦から参加" },
          ],
        });
        fixture.update(next);
        await route.fulfill({ json: { room: next, membership: { ...identity, token } } });
      });
      const url = `/rooms/${room.id}?invite=${room.instanceId}`;
      await page.goto(url);
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("textbox", { name: "ニックネーム" })).toBeFocused();
      if (closeWith === "Escape") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: closeWith, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const join = page
        .getByLabel("対局状況")
        .getByRole("button", { name: "参加する", exact: true });
      await expect(join).toBeFocused();
      await page.reload();
      await expect(join).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`\\?invite=${room.instanceId}$`));
      expect(sent).toBeUndefined();
      if (width < 1280) {
        await page.getByRole("tab", { name: "チャット", exact: true }).click();
        await expect(page.getByRole("tab", { name: "チャット", exact: true })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await page.getByRole("tab", { name: "盤面", exact: true }).click();
        await expect(page.getByRole("tab", { name: "盤面", exact: true })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(dialog).toHaveCount(0);
      }
      await join.click();
      await dialog.getByRole("textbox", { name: "ニックネーム" }).fill("観戦から参加");
      await dialog.getByRole("button", { name: "参加する", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText("観戦から参加", { exact: true }).first()).toBeVisible();
      expect(sent).toEqual({ name: "観戦から参加", instanceId: room.instanceId });
    });
  }

  test(`${game}の招待は表示時に記録し、ロビー往復・部屋の世代変更を区別する`, async ({
    page,
    context,
  }) => {
    const room = createRoom();
    const fixture = await mockRoom(page, room, false);
    await mockLobby(page);
    const url = `/rooms/${room.id}?invite=${room.instanceId}`;
    await page.goto(url);
    await expect(
      page.getByText("満室のため、今は観戦のみできます。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    room.players = room.players.slice(0, 1);
    fixture.update(room);
    await page.reload();
    await expect(page.getByRole("dialog")).toBeVisible();
    // 閉じる前に更新しても、自動表示は消費済みです。
    await page.reload();
    await expect(
      page.getByLabel("対局状況").getByRole("button", { name: "参加する", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("link", { name: "ロビーへ戻る", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: game === "将棋" ? "四人将棋" : "四人リバーシ",
        exact: true,
      }),
    ).toBeVisible();
    await page.goto(url);
    await expect(
      page.getByLabel("対局状況").getByRole("button", { name: "参加する", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const otherTab = await context.newPage();
    await mockRoom(otherTab, room, false);
    await otherTab.goto(url);
    await expect(otherTab.getByRole("dialog")).toBeVisible();
    await otherTab.close();

    const next = { ...room, instanceId: "00000000-0000-4000-8000-000000000099" };
    fixture.update(next);
    await page.goto(`/rooms/${next.id}?invite=${next.instanceId}`);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.goto(url);
    await expect(
      page.getByText(
        "このルームは閉鎖されています。新しい招待リンクを確認するか、ロビーへ戻ってください。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test(`${game}の参加済み招待では自動表示しない`, async ({ page }) => {
    const room = createRoom();
    room.players = room.players.slice(0, 1);
    await mockRoom(page, room);
    await page.goto(`/rooms/${room.id}?invite=${room.instanceId}`);
    await expect(page.getByRole("button", { name: "準備完了", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "準備完了", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test(`${game}の対局中の招待では表示せず、初回の参加可能なアクセスで表示する`, async ({
    page,
  }) => {
    const room = createPlayingRoom();
    const fixture = await mockRoom(page, room, false);
    await page.goto(`/rooms/${room.id}?invite=${room.instanceId}`);
    await expect(
      page.getByText("対局中のため、今は観戦のみできます。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const waiting = createRoom();
    waiting.players = waiting.players.slice(0, 1);
    fixture.update(waiting);
    await page.reload();
    await expect(
      page.getByRole("dialog").getByRole("textbox", { name: "ニックネーム" }),
    ).toBeFocused();
  });

  test(`${game}の招待は保存領域を利用できなくても閉じて観戦できる`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", {
        get() {
          throw new DOMException("Storage disabled", "SecurityError");
        },
      });
    });
    const room = createRoom();
    room.players = room.players.slice(0, 1);
    await mockRoom(page, room, false);
    await page.goto(`/rooms/${room.id}?invite=${room.instanceId}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "観戦する" }).click();
    await expect(dialog).toHaveCount(0);
    await page
      .getByLabel("対局状況")
      .getByRole("button", { name: "参加する", exact: true })
      .click();
    await expect(dialog.getByRole("textbox", { name: "ニックネーム" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}
