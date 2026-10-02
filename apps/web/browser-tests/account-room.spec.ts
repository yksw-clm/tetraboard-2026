import { expect, test } from "@playwright/test";
import { roomSchema, roomTimeControl, roomPublicMetadataSchema } from "@tetraboard/protocol";
import { mockAccount, profile } from "./accountFixtures";
import { mockRoom, waitingRoom, membership, token, playerIds } from "./fixtures";

function onePlayerRoom() {
  const room = waitingRoom();
  return roomSchema.parse({ ...room, players: room.players.slice(0, 1) });
}
for (const width of [320, 900, 1440]) {
  test(`アカウントで作成しプロフィールとCPUアバターを表示する ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const base = onePlayerRoom();
    const icon = "/api/avatars/00000000-0000-4000-8000-000000000099";
    if (base.players[0]?.kind === "human") base.players[0].avatarUrl = icon;
    const room = roomSchema.parse({
      ...base,
      players: [
        ...base.players,
        {
          id: playerIds[1],
          name: "CPU 1",
          kind: "cpu",
          level: 1,
          ready: true,
          color: null,
          reconnectDeadline: null,
        },
      ],
    });
    await mockRoom(page, room, false);
    await mockAccount(page, { ...profile, avatarUrl: icon });
    await page.route(`**${icon}`, (route) =>
      route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE8sAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
    let sent: unknown;
    await page.route("**/api/rooms", async (route) => {
      if (route.request().method() === "POST") {
        sent = route.request().postDataJSON();
        await route.fulfill({ status: 201, json: { room, membership: { ...membership, token } } });
      } else await route.fulfill({ json: { rooms: [], nextCursor: null } });
    });
    await page.goto("/games/four-reversi");
    await page.getByRole("button", { name: /^ルームを作る/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("参加するアカウント")).toContainText(profile.name);
    await expect(dialog.getByRole("textbox", { name: "ニックネーム" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "ルームを作る", exact: true }).click();
    await expect(page).toHaveURL(/\/rooms\/12345$/);
    expect(sent).toEqual({ quickPlay: false, mode: "singles" });
    await expect(page.getByTestId("player-avatar").locator("img")).toHaveAttribute("src", icon);
    const cpu = page.getByTestId("player-card").filter({ hasText: "CPU Lv1" });
    await expect(cpu.getByTestId("player-avatar")).toHaveCSS("color", "rgb(55, 101, 151)");
    await expect(cpu.getByTestId("player-avatar").getByTitle("CPU")).toHaveCount(0);
    await expect(cpu.getByTestId("player-name").locator("svg")).toHaveCount(0);
    await expect(cpu.getByTitle("CPU").locator("svg")).toHaveCount(1);
    await testInfo.attach(`account-room-${width}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });

  test(`ロビーはホスト名とアイコン、人数と4つの丸ぽちを表示する ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockAccount(page, null);
    const rooms = [
      [2, 0],
      [1, 3],
      [1, 0],
    ].map(([humanCount, cpuCount], index) =>
      roomPublicMetadataSchema.parse({
        id: String(12345 + index),
        game: "four-reversi",
        mode: "singles",
        timeControl: roomTimeControl,
        status: "waiting",
        hostName: profile.name,
        hostAvatarUrl: null,
        humanCount,
        cpuCount,
        capacity: 4,
        openSeats: 4 - humanCount! - cpuCount!,
        updatedAtMs: 1,
      }),
    );
    await page.route("**/api/rooms", (route) =>
      route.fulfill({ json: { rooms, nextCursor: null } }),
    );
    await page.goto("/games/four-reversi");
    const rows = page.getByRole("list").getByRole("listitem");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator("strong").first()).toHaveText(profile.name);
    await expect(rows.nth(0)).toContainText("2/4");
    await expect(rows.nth(1)).toContainText("4/4");
    await expect(rows.nth(1)).not.toContainText("満室");
    await expect(rows.nth(1)).not.toContainText("人間1人");
    const colors = [
      ["rgb(52, 168, 113)", "rgb(52, 168, 113)", "rgb(203, 211, 206)", "rgb(203, 211, 206)"],
      ["rgb(52, 168, 113)", "rgb(55, 101, 151)", "rgb(55, 101, 151)", "rgb(55, 101, 151)"],
    ];
    for (let row = 0; row < 2; row++) {
      const dots = rows.nth(row).getByRole("img").locator("span");
      await expect(dots).toHaveCount(4);
      for (let dot = 0; dot < 4; dot++)
        await expect(dots.nth(dot)).toHaveCSS("background-color", colors[row]![dot]!);
    }
    await expect(page.getByRole("button", { name: "ルーム 12346 に参加" })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await testInfo.attach(`lobby-occupancy-${width}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}

for (const entry of ["番号", "招待", "観戦から"]) {
  test(`アカウントで${entry}参加しニックネームを送信しない`, async ({ page }) => {
    const room = onePlayerRoom();
    const identity = { playerId: playerIds[1]!, role: "player" as const };
    const fixture = await mockRoom(page, room, false, identity);
    await mockAccount(page, profile);
    let sent: unknown;
    await page.route("**/api/rooms/12345/players", async (route) => {
      sent = route.request().postDataJSON();
      const next = roomSchema.parse({
        ...room,
        players: [
          ...room.players,
          { ...room.players[0], id: identity.playerId, name: profile.name },
        ],
      });
      fixture.update(next);
      await route.fulfill({ json: { room: next, membership: { ...identity, token } } });
    });
    if (entry === "番号") {
      await page.goto("/games/four-reversi");
      await page.getByRole("button", { name: /^ルーム番号で参加/ }).click();
      await page.getByRole("textbox", { name: "ルーム番号" }).fill("12345");
    } else {
      await page.goto(`/rooms/12345${entry === "招待" ? `?invite=${room.instanceId}` : ""}`);
      if (entry === "観戦から")
        await page.getByRole("button", { name: "参加する", exact: true }).click();
    }
    await expect(page.getByRole("dialog").getByLabel("参加するアカウント")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "参加する", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(sent).toEqual(entry === "番号" ? {} : { instanceId: room.instanceId });
  });
}

test("重複参加の理由を表示し、認証取得失敗時はゲスト参加へ降格しない", async ({ page }) => {
  await mockAccount(page, profile);
  let posts = 0;
  await page.route("**/api/rooms", (route) => {
    if (route.request().method() === "POST") {
      posts++;
      return route.fulfill({ status: 409, json: { error: "account_seated" } });
    }
    return route.fulfill({ json: { rooms: [], nextCursor: null } });
  });
  await page.goto("/games/four-reversi");
  await page.getByRole("button", { name: /^ルームを作る/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "ルームを作る", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("既にルームに参加しています");
  expect(posts).toBe(1);
  await page.route("**/api/account/session", (route) =>
    route.fulfill({ status: 503, json: { message: "確認できません" } }),
  );
  await dialog.getByRole("button", { name: "ルームを作る", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("通信を確認");
  expect(posts).toBe(1);
  await expect(dialog.getByRole("textbox", { name: "ニックネーム" })).toHaveCount(0);
});
