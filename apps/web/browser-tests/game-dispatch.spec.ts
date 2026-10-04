import { expect, test } from "@playwright/test";
import { mockRoom, waitingRoom } from "./fixtures";
import { waitingShogiRoom } from "./fourShogiFixtures";
import { mockAccount, profile } from "./accountFixtures";
import { replayMatch } from "./matchReplayFixtures";
import { shogiReplayMatch } from "./fourShogiRecordFixtures";

for (const game of ["four-reversi", "four-shogi"] as const) {
  const shogi = game === "four-shogi";
  const name = shogi ? "FourShogi" : "FourReversi";
  const other = shogi ? "FourReversi" : "FourShogi";
  test(`${game}: 直接アクセスと再読み込みで選択ゲームのライブだけを取得する`, async ({ page }) => {
    const scripts: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(request.url());
    });
    const room = shogi ? waitingShogiRoom() : waitingRoom();
    const fixture = await mockRoom(page, room, false);
    await page.route("**/api/analytics/**", (route) => route.fulfill({ status: 204 }));
    await page.goto("/rooms/12345");
    const board = page.getByRole("group", {
      name: shogi ? "四人将棋の盤面" : "四人リバーシの盤面",
      exact: true,
    });
    await expect(board).toBeVisible();
    await page.reload();
    await expect(board).toBeVisible();
    if (process.env.CI) {
      expect(scripts.some((url) => url.includes(`${name}RoomDetail-`))).toBe(true);
      expect(
        scripts.some(
          (url) =>
            url.includes(`${other}RoomDetail-`) ||
            url.includes("MatchReplayView-") ||
            url.includes("fourShogiMatchReplay-"),
        ),
      ).toBe(false);
    }
    const foreign = shogi ? waitingRoom() : waitingShogiRoom();
    fixture.update({ ...foreign, id: room.id, instanceId: room.instanceId });
    await expect(page.getByRole("alert")).toContainText("ルーム");
    await expect(board).toHaveCount(0);
  });
  test(`${game}: 保存棋譜は対応画面と必要な前処理だけを取得する`, async ({ page }) => {
    const scripts: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(request.url());
    });
    await mockAccount(page, profile);
    const fixture = shogiReplayMatch();
    const match = shogi ? fixture.detail : replayMatch();
    await page.route(/\/api\/account\/matches\/[^/?]+$/, (route) =>
      route.fulfill({ json: { match } }),
    );
    await page.route(/\/api\/account\/matches\/[^/?]+\/replay(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: fixture.page(Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0)),
      }),
    );
    await page.goto(`/account/matches/${match.id}`);
    await expect(
      page.getByRole("group", {
        name: shogi ? "四人将棋の盤面" : "四人リバーシの盤面",
        exact: true,
      }),
    ).toBeVisible();
    if (process.env.CI) {
      expect(scripts.some((url) => url.includes(`${name}MatchReplayView-`))).toBe(true);
      expect(
        scripts.some(
          (url) => url.includes(`${other}MatchReplayView-`) || url.includes("RoomDetail-"),
        ),
      ).toBe(false);
      expect(scripts.some((url) => url.includes("fourShogiMatchReplay-"))).toBe(shogi);
    }
  });
}
