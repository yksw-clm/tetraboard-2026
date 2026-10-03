import { expect, test, type Locator } from "@playwright/test";
import { mockLobby, mockRoom, playingRoom, waitingRoom } from "./fixtures";
import { playingShogiRoom, waitingShogiRoom } from "./fourShogiFixtures";
import { roomSchema, type Room } from "@tetraboard/protocol";
import { replayMatch } from "./matchReplayFixtures";
import { shogiReplayMatch } from "./fourShogiRecordFixtures";
import { expectReplaySelectFits } from "./replaySelectAssertions";

const radioField = (radio: Locator) => radio.locator("xpath=ancestor::*[@data-slot='radio'][1]");

async function circle(radio: Locator, color: string, locallyControlled = true) {
  const control = radioField(radio).locator('[data-slot="radio-control"]');
  await expect(control).toHaveCSS("border-top-width", "1px");
  await expect(control).toHaveCSS("border-top-color", color);
  await expect(control).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await control.click();
  if (locallyControlled) {
    await expect(radio).toBeChecked();
    await expect(control).toHaveCSS(
      "background-color",
      color === "rgb(117, 101, 74)" ? "rgb(242, 188, 59)" : "rgb(39, 132, 85)",
    );
  }
}

for (const game of ["four-reversi", "four-shogi"] as const) {
  for (const width of [320, 390, 768, 1440]) {
    test(game + " ラジオの丸・文字・余白とキーボード " + width, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 850 });
      await mockLobby(page);
      await page.goto("/games/" + game);
      const color = game === "four-shogi" ? "rgb(117, 101, 74)" : "rgb(101, 115, 108)";
      for (const entrance of [/^すぐ遊ぶ/, /^ルームを作る/]) {
        await page.getByRole("button", { name: entrance }).click();
        const dialog = page.getByRole("dialog");
        const doubles = dialog.getByRole("radio", { name: /ダブルス/ });
        const singles = dialog.getByRole("radio", { name: /シングルス/ });
        await circle(doubles, color);
        await radioField(singles).getByText("シングルス", { exact: true }).click();
        await expect(singles).toBeChecked();
        const control = await radioField(doubles)
          .locator('[data-slot="radio-control"]')
          .boundingBox();
        if (!control) throw new Error("Radio circle missing");
        await page.mouse.click(control.x + control.width + 3, control.y + control.height / 2);
        await expect(doubles).toBeChecked();
        await singles.focus();
        await page.keyboard.press("Space");
        await expect(singles).toBeChecked();
        if (game === "four-shogi") {
          const off = dialog.getByRole("radio", { name: "OFF", exact: true });
          await circle(off, color);
          await radioField(dialog.getByRole("radio", { name: "ON", exact: true }))
            .getByText("ON", { exact: true })
            .click();
          await expect(off).not.toBeChecked();
        }
        await page.screenshot({ path: info.outputPath("radio.png") });
        await page.keyboard.press("Escape");
      }
      const room = game === "four-shogi" ? waitingShogiRoom() : waitingRoom();
      const control = await mockRoom(page, room);
      await page.goto("/rooms/12345");
      if (width < 1280) await page.getByRole("tab", { name: "ルーム", exact: true }).click();
      await page.getByRole("button", { name: "ルーム設定" }).click();
      await circle(page.getByRole("radio", { name: "ダブルス", exact: true }), color, false);
      await expect
        .poll(() => control.received.filter((m) => m.type === "room.mode.set"))
        .toEqual([{ type: "room.mode.set", mode: "doubles" }]);
      await expect(page.getByRole("radio", { name: "シングルス", exact: true })).toBeDisabled();
      room.settings.mode = "doubles";
      control.update(room);
      await expect(page.getByRole("radio", { name: "ダブルス", exact: true })).toBeChecked();
      if (room.settings.game === "four-shogi") {
        await circle(page.getByRole("radio", { name: "OFF", exact: true }), color, false);
        await expect
          .poll(() => control.received)
          .toContainEqual({
            type: "room.three-player-attack.set",
            prohibited: false,
          });
      }
    });

    test(game + " 再接続と操作エラーで位置を動かさない " + width, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 320 ? 573 : 760 });
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
          },
        }),
      );
      const withReplay = width === 320 || width === 768;
      let releaseReplay = () => {};
      const replayResponse = new Promise<void>((resolve) => {
        releaseReplay = resolve;
      });
      let room: Room = game === "four-shogi" ? playingShogiRoom() : playingRoom();
      if (withReplay && game === "four-reversi") {
        const match = replayMatch();
        room = roomSchema.parse({
          ...waitingRoom(),
          lastRound: {
            game: match.game,
            replay: match.replay,
            players: match.participants.map(({ id, name, color }) => ({ id, name, color })),
          },
        });
      } else if (withReplay) {
        const match = shogiReplayMatch();
        room = roomSchema.parse({
          ...waitingShogiRoom(),
          lastRound: {
            game: match.detail.game,
            roundId: match.detail.id,
            eventCount: match.events.length,
            players: match.detail.participants.map(({ id, name, side }) => ({ id, name, side })),
          },
        });
        await page.route("**/api/rooms/12345/rounds/*/replay?*", async (route) => {
          await replayResponse;
          const { matchId, ...chunk } = match.page(
            Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0),
          );
          return route.fulfill({
            json: { ...chunk, roundId: matchId, instanceId: room.instanceId },
          });
        });
      }
      const control = await mockRoom(page, room);
      await page.goto("/rooms/12345");
      if (withReplay && game === "four-shogi") {
        await expect(page.getByRole("button", { name: /棋譜の局面$/ })).toHaveCount(0);
        releaseReplay();
      }
      if (withReplay)
        await expect(page.getByRole("button", { name: "棋譜を1つ戻る" })).toBeEnabled();
      // 棋譜取得後の描画とResizeObserverの反映を待ってから通知だけを比較します。
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const panel = page.getByRole("group", {
        name: game === "four-shogi" ? "四人将棋の盤面" : "四人リバーシの盤面",
        exact: true,
      });
      const before = await panel.boundingBox();
      const cards = page.getByTestId("player-card");
      const beforeCards = await cards.evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        }),
      );
      const notice = page.getByRole("status").filter({ hasText: "再接続中" });
      control.disconnect();
      await expect(notice).toBeVisible();
      expect(await panel.boundingBox()).toEqual(before);
      expect(
        await cards.evaluateAll((nodes) =>
          nodes.map((n) => {
            const r = n.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height];
          }),
        ),
      ).toEqual(beforeCards);
      const box = await notice.boundingBox();
      if (!box) throw new Error("Notice missing");
      expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(1);
      expect(box.y).toBeGreaterThanOrEqual(8);
      expect(box.width).toBeLessThanOrEqual(Math.min(480, width - 16));
      await expect(notice).toHaveCSS("pointer-events", "none");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.elementFromPoint(innerWidth / 2, 10)?.closest('[role="status"]') === null,
          ),
        )
        .toBe(true);
      await page.screenshot({ path: info.outputPath("reconnecting.png") });
      control.reconnect();
      await expect(notice).toHaveCount(0);
      expect(await panel.boundingBox()).toEqual(before);
      control.send({ type: "room.error", error: "invalid_move" });
      await expect(
        page.getByRole("status").filter({
          hasText: game === "four-shogi" ? "その手は指せません" : "その場所には石を置けません",
        }),
      ).toBeVisible();
      expect(await panel.boundingBox()).toEqual(before);
      if (withReplay) {
        await page.getByRole("button", { name: /棋譜の局面$/ }).click();
        await expectReplaySelectFits(page);
        const popup = page.locator('[data-slot="select-popover"]');
        const zIndex = await popup.evaluate((element) => {
          let maximum = 0;
          for (let parent: Element | null = element; parent; parent = parent.parentElement)
            maximum = Math.max(maximum, Number.parseInt(getComputedStyle(parent).zIndex) || 0);
          return maximum;
        });
        expect(zIndex).toBeGreaterThan(10);
        await page.getByRole("option", { name: "開始局面", exact: true }).click();
        await expect(page.getByRole("button", { name: "棋譜を1つ戻る" })).toBeDisabled();
      }
      if (width < 1280) await page.getByRole("tab", { name: "ルーム", exact: true }).click();
      await page.getByRole("button", { name: "招待リンクをコピー" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "閉じる", exact: true }).first().click();
      await expect(dialog).toHaveCount(0);
      await page.keyboard.press("Escape");
    });
  }
}
