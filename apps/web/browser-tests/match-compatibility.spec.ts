import { expect, test } from "@playwright/test";
import { mockAccount, profile } from "./accountFixtures";
import { reversiArchives, shogiArchives } from "../../../test-fixtures/matches";
import firebaseReversi from "../../../test-fixtures/matches/firebase-four-reversi.json" with { type: "json" };
test("Firebase棋譜の時間設定は不明で、旧初期局面から最終手まで再生できる", async ({ page }) => {
  await mockAccount(page, profile);
  await page.route(/\/api\/account\/matches\/[^/?]+$/, (route) =>
    route.fulfill({ json: { match: firebaseReversi.detail } }),
  );
  await page.goto(`/account/matches/${firebaseReversi.detail.id}`);
  const previous = page.getByRole("button", { name: "棋譜を1つ戻る", exact: true });
  await expect(previous).toBeEnabled();
  await expect(page.locator("dl").getByText("不明", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: /棋譜の局面$/ }).click();
  await page.getByRole("option", { name: "開始局面", exact: true }).click();
  await expect(previous).toBeDisabled();
  await page.getByRole("button", { name: "棋譜を1つ進む", exact: true }).click();
  await expect(previous).toBeEnabled();
  await page.reload();
  await expect(previous).toBeEnabled();
  await expect(page.getByText("不明", { exact: true })).toHaveCount(2);
});
for (const fixture of [
  reversiArchives[0],
  reversiArchives[1],
  shogiArchives[0],
  shogiArchives[1],
  shogiArchives[4],
]) {
  test(`${fixture.name}: 固定棋譜を直接開き、再読込・局面移動・取得失敗から復帰する`, async ({
    page,
  }) => {
    await mockAccount(page, profile);
    let unavailable = false;
    const online: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/rooms")) online.push(request.url());
    });
    const sockets: string[] = [];
    page.on("websocket", (socket) => {
      if (socket.url().includes("/api/rooms")) sockets.push(socket.url());
    });
    await page.route(/\/api\/account\/matches\/[^/?]+$/, (route) =>
      route.fulfill(
        unavailable
          ? {
              status: 503,
              json: { message: "棋譜を取得できませんでした。もう一度お試しください。" },
            }
          : { json: { match: fixture.detail } },
      ),
    );
    await page.route(/\/api\/account\/matches\/[^/?]+\/replay(?:\?.*)?$/, (route) => {
      const cursor = Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0);
      return route.fulfill({
        json: {
          matchId: fixture.detail.id,
          ...fixture.detail.replay,
          events: fixture.events.slice(cursor, cursor + 100),
          nextCursor: cursor + 100 < fixture.events.length ? cursor + 100 : null,
        },
      });
    });
    await page.goto(`/account/matches/${fixture.detail.id}`);
    const previous = page.getByRole("button", { name: "棋譜を1つ戻る", exact: true });
    await expect(previous).toBeEnabled();
    await page.reload();
    await expect(previous).toBeEnabled();
    const final = fixture.checkpoints.at(-1);
    if (!final) throw Error("Missing final frame");
    await expect(
      page.getByRole("button", { name: new RegExp(`${final.frame.label}.*棋譜の局面$`) }),
    ).toBeVisible();
    await page.getByRole("button", { name: /棋譜の局面$/ }).click();
    await page.getByRole("option", { name: "開始局面", exact: true }).click();
    await expect(previous).toBeDisabled();
    await page.getByRole("button", { name: "棋譜を1つ進む", exact: true }).click();
    await expect(previous).toBeEnabled();
    await page.getByRole("button", { name: "結果", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    unavailable = true;
    await page.reload();
    await expect(page.getByRole("button", { name: "再試行", exact: true })).toBeVisible();
    unavailable = false;
    await page.getByRole("button", { name: "再試行", exact: true }).click();
    await expect(previous).toBeEnabled();
    expect(online).toEqual([]);
    expect(sockets).toEqual([]);
  });
}
