import { expect, test, type Page } from "@playwright/test";
import {
  applyAction,
  eliminateSide,
  sides,
  type FourShogiState,
  type Side,
} from "@tetraboard/four-shogi";
import {
  formationAction,
  formationState,
  type FixtureFormationId,
} from "../../../test-fixtures/shogiFormations";
import { mockRoom, now, membership, playerIds } from "./fixtures";
import { initialShogiState, playingShogiRoom, waitingShogiRoom } from "./fourShogiFixtures";
import { expectShogiLayoutFits } from "./shogiLayoutAssertions";

const notice = (page: Page) => page.getByTestId("shogi-formation-notice");
const squareName = ({ x, y }: { x: number; y: number }) => `${"ABCDEFGHI"[x]}${y + 1}`;
const square = (page: Page, name: string) =>
  page.getByTestId("shogi-board").locator(`[data-square="${name}"]`);
function before(id: FixtureFormationId = "riggtosfar", side: Side = "south") {
  const state = formationState(initialShogiState(), id, side, false);
  if (state.status !== "playing") throw new Error("Expected playing fixture");
  return { ...state, players: initialShogiState().players };
}
function complete(
  state: FourShogiState,
  id: FixtureFormationId = "riggtosfar",
  side: Side = "south",
) {
  const result = applyAction(state, side, formationAction(id, side));
  if (!result.ok) throw new Error(result.reason);
  if (result.state.status !== "playing") throw new Error("Expected playing fixture");
  return result.state;
}
async function sendCompletion(
  page: Page,
  id: FixtureFormationId = "riggtosfar",
  side: Side = "south",
) {
  const action = formationAction(id, side);
  await square(page, squareName(action.from)).click();
  await square(page, squareName(action.to)).click();
  await expect(square(page, squareName(action.to))).toHaveAttribute("data-pending-move", "true");
}
async function dimensions(page: Page) {
  return page
    .getByTestId("shogi-board")
    .or(page.getByTestId("player-card"))
    .or(page.getByTestId("shogi-hand"))
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      }),
    );
}

for (const width of [320, 390, 768, 1440])
  for (const side of sides) {
    test(`${width}px・${side}: 確定後だけ本人へ2秒表示し、水平な最長名称を盤内へ収める`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.clock.install({ time: now });
      const state = before("riggtosfar", side);
      const room = playingShogiRoom(state);
      const identity = { ...membership, playerId: playerIds[sides.indexOf(side)]! };
      const fixture = await mockRoom(page, room, true, identity, true);
      await page.goto("/rooms/12345");
      await expect(
        square(page, squareName(formationAction("riggtosfar", side).from)),
      ).toBeEnabled();
      await expectShogiLayoutFits(page);
      await page.clock.pauseAt(now + 60000);
      const bounds = await dimensions(page);
      await sendCompletion(page, "riggtosfar", side);
      await expect(notice(page)).toHaveCount(0);
      // サーバーの付加結果がnullでも、クライアントは確定盤面で判定する。
      fixture.update(playingShogiRoom(complete(state, "riggtosfar", side), 1));
      await expect(notice(page)).toHaveText("リッグトスファー");
      await expect(notice(page)).toHaveAttribute("role", "status");
      await expect(notice(page)).toHaveAttribute("aria-live", "polite");
      await expect(notice(page)).toHaveCSS("pointer-events", "none");
      await expect(notice(page)).toHaveCSS("animation-name", "none");
      await expect(notice(page)).toHaveCSS("opacity", "1");
      expect(
        await notice(page).evaluate((el) => {
          const b = el.parentElement!.getBoundingClientRect(),
            r = el.getBoundingClientRect();
          return {
            inside:
              r.left >= b.left && r.right <= b.right && r.top >= b.top && r.bottom <= b.bottom,
            centered: Math.abs((r.left + r.right) / 2 - (b.left + b.right) / 2) < 1,
            secondRank: Math.abs((r.top + r.bottom) / 2 - (b.top + (b.height * 7.5) / 9)) < 1,
            horizontal: getComputedStyle(el).writingMode === "horizontal-tb",
            focused: document.activeElement === el,
          };
        }),
      ).toEqual({
        inside: true,
        centered: true,
        secondRank: true,
        horizontal: true,
        focused: false,
      });
      expect(await dimensions(page)).toEqual(bounds);
      expect(new URL(fixture.socketUrls[0]!).searchParams.get("formationAnalysis")).toBe("1");
      await page.clock.runFor(1999);
      await expect(notice(page)).toBeVisible();
      await page.clock.runFor(1);
      await expect(notice(page)).toHaveCount(0);
      expect(await dimensions(page)).toEqual(bounds);
    });
  }

for (const width of [390, 1440]) {
  test(`${width}px: ふわっと現れて消え、位置を動かさず操作時は即時解除する`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.clock.install({ time: now });
    const state = before();
    const fixture = await mockRoom(page, playingShogiRoom(state));
    await page.goto("/rooms/12345");
    await expect(square(page, "F8")).toBeEnabled();
    await page.clock.pauseAt(now + 60000);
    const bounds = await dimensions(page);
    const formed = playingShogiRoom({ ...complete(state), turn: "south" }, 1);
    fixture.update(formed);
    await expect(notice(page)).toHaveText("リッグトスファー");
    await expect(notice(page)).toHaveCSS("animation-name", "shogi-formation-fade");
    await expect(notice(page)).toHaveCSS("animation-duration", "2s");
    const sample = (time: number) =>
      notice(page).evaluate((el, time) => {
        const animation = el.getAnimations()[0]!;
        animation.pause();
        animation.currentTime = time;
        const r = el.getBoundingClientRect();
        return {
          opacity: Number(getComputedStyle(el).opacity),
          box: [r.x, r.y, r.width, r.height],
        };
      }, time);
    const first = await sample(0);
    expect(first.opacity).toBe(0);
    for (const time of [90, 1880]) {
      const frame = await sample(time);
      expect(frame.opacity).toBeGreaterThan(0);
      expect(frame.opacity).toBeLessThan(1);
      expect(frame.box).toEqual(first.box);
    }
    expect((await sample(180)).opacity).toBe(1);
    expect((await sample(1760)).opacity).toBe(1);
    expect((await sample(2000)).opacity).toBe(0);
    expect(await dimensions(page)).toEqual(bounds);
    await page.clock.runFor(1999);
    await expect(notice(page)).toHaveCount(1);
    await page.clock.runFor(1);
    await expect(notice(page)).toHaveCount(0);
    const roundId = "00000000-0000-4000-8000-000000000021";
    fixture.update({ ...playingShogiRoom(state), roundId });
    await expect(square(page, "F8")).toBeEnabled();
    fixture.update({ ...formed, roundId });
    await expect(notice(page)).toHaveText("リッグトスファー");
    await square(page, "E8").click();
    await expect(notice(page)).toHaveCount(0);
    expect(await dimensions(page)).toEqual(bounds);
  });
}

test("選択・クリック透過・ドラッグ・成り選択で通知を消し、再演しない", async ({ page }) => {
  await page.clock.install({ time: now });
  const initial = before();
  const state = {
    ...initial,
    nextPieceId: 100,
    board: initial.board.map((row, y) =>
      row.map((piece, x) =>
        x === 3 && y === 3
          ? { id: 99, side: "south" as const, kind: "silver" as const, promoted: false }
          : piece,
      ),
    ),
  };
  const fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345");
  await expect(square(page, "F8")).toBeEnabled();
  await page.clock.pauseAt(now + 60000);
  let round = 20;
  const show = async () => {
    const roundId = `00000000-0000-4000-8000-0000000000${++round}`;
    fixture.update({ ...playingShogiRoom(state), roundId });
    await expect(square(page, "F8").getByTestId("shogi-piece")).toHaveCount(1);
    fixture.update({ ...playingShogiRoom({ ...complete(state), turn: "south" }, 1), roundId });
    await expect(notice(page)).toBeVisible();
    await expect(square(page, "E8")).toBeEnabled();
  };
  await show();
  const label = await notice(page).boundingBox();
  await page.mouse.click(label!.x + label!.width / 2, label!.y + label!.height / 2);
  await expect(square(page, "E8")).toHaveAttribute("aria-pressed", "true");
  await expect(notice(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.clock.runFor(2001);
  await expect(notice(page)).toHaveCount(0);
  await show();
  const from = await square(page, "E8").boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + from!.width / 2 + 15, from!.y + from!.height / 2 + 15);
  await expect(notice(page)).toHaveCount(0);
  await page.mouse.move(1, 1);
  await page.mouse.up();
  await show();
  await square(page, "D4").click();
  await square(page, "D3").click();
  await expect(page.getByRole("button", { name: "成る", exact: true })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(notice(page)).toHaveCount(0);
});

test("再成立・再読み込みは抑止し、次局だけ記録を置き換える", async ({ page }) => {
  const state = before("tenshukaku");
  const fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345");
  await expect(square(page, "F8")).toBeEnabled();
  fixture.update(playingShogiRoom(complete(state, "tenshukaku"), 1));
  await expect(notice(page)).toHaveText("天守閣玉");
  fixture.update(playingShogiRoom({ ...state, moveNumber: 2 }, 2));
  await expect(square(page, "F8")).toBeEnabled();
  fixture.update(playingShogiRoom(complete({ ...state, moveNumber: 2 }, "tenshukaku"), 3));
  await expect(notice(page)).toHaveText("天守閣玉");
  // 再成立でもタイマーを延長せず、再読み込み後も既知IDを通知しない。
  await page.reload();
  await expect(square(page, "E7").getByTestId("shogi-piece")).toHaveCount(1);
  await expect(notice(page)).toHaveCount(0);
  fixture.update(playingShogiRoom({ ...state, moveNumber: 4 }, 4));
  await expect(square(page, "F8")).toBeEnabled();
  fixture.update(playingShogiRoom(complete({ ...state, moveNumber: 4 }, "tenshukaku"), 5));
  await expect(square(page, "E7")).toHaveAttribute("data-last-move", "to");
  await expect(notice(page)).toHaveCount(0);
  const roundId = "00000000-0000-4000-8000-000000000021";
  fixture.update({ ...playingShogiRoom(state), roundId });
  await expect(square(page, "F8")).toBeEnabled();
  fixture.update({ ...playingShogiRoom(complete(state, "tenshukaku"), 1), roundId });
  await expect(notice(page)).toHaveText("天守閣玉");
  expect(
    await page.evaluate(() =>
      Object.entries(sessionStorage)
        .filter(([key]) => key.endsWith(":formations"))
        .map(([, value]) => JSON.parse(value)),
    ),
  ).toEqual([
    {
      scope: `${playingShogiRoom(state).instanceId}:${playerIds[0]}:${roundId}:1`,
      seen: ["tenshukaku"],
    },
  ]);
});

test("初回成立・履歴飛び・他人・観戦・脱落・待機は通知せず、切断時に消す", async ({ page }) => {
  await page.clock.install({ time: now });
  const state = before();
  const fixture = await mockRoom(page, playingShogiRoom(complete(state)));
  await page.goto("/rooms/12345");
  await expect(page.getByTestId("shogi-board")).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await page.clock.pauseAt(now + 60000);
  const nextRound = "00000000-0000-4000-8000-000000000021";
  fixture.update({ ...playingShogiRoom(state), roundId: nextRound });
  await expect(square(page, "F8")).toBeEnabled();
  fixture.update({ ...playingShogiRoom(complete(state), 3), roundId: nextRound });
  await expect(square(page, "E8")).toHaveAttribute("data-last-move", "to");
  await expect(notice(page)).toHaveCount(0);
  const ownRound = "00000000-0000-4000-8000-000000000022";
  fixture.update({ ...playingShogiRoom(state), roundId: ownRound });
  await expect(square(page, "F8")).toBeEnabled();
  fixture.update({ ...playingShogiRoom(complete(state), 1), roundId: ownRound });
  await expect(notice(page)).toBeVisible();
  fixture.disconnect();
  await expect(notice(page)).toHaveCount(0);
  await page.clock.runFor(1000);
  fixture.reconnect();
  await expect(page.getByRole("status").filter({ hasText: "再接続中" })).toHaveCount(0);
  await expect(notice(page)).toHaveCount(0);
  const eliminated = eliminateSide(complete(state), "south", "left");
  if (!eliminated.ok) throw new Error("fixture elimination");
  fixture.update({ ...playingShogiRoom(eliminated.state, 2), roundId: ownRound });
  await expect(notice(page)).toHaveCount(0);
  fixture.update(waitingShogiRoom());
  await expect(notice(page)).toHaveCount(0);
});

for (const asPlayer of [true, false])
  test(`${asPlayer ? "他人の成立" : "観戦"}は通知しない`, async ({ page }) => {
    const side = asPlayer ? "west" : "south";
    const state = before("tenshukaku", side);
    const fixture = await mockRoom(page, playingShogiRoom(state), asPlayer);
    await page.goto("/rooms/12345");
    await expect(page.getByTestId("shogi-board")).toBeVisible();
    fixture.update(playingShogiRoom(complete(state, "tenshukaku", side), 1));
    await expect(square(page, squareName(formationAction("tenshukaku", side).to))).toHaveAttribute(
      "data-last-move",
      "to",
    );
    await expect(notice(page)).toHaveCount(0);
  });

test("保存領域が利用できない場合も成立と再成立抑止を継続する", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith(":formations")) throw new Error("Storage unavailable");
      return original.call(this, key, value);
    };
  });
  const state = before();
  const fixture = await mockRoom(page, playingShogiRoom(state));
  await page.goto("/rooms/12345");
  await expect(square(page, "F8")).toBeEnabled();
  fixture.update(playingShogiRoom({ ...complete(state), turn: "south" }, 1));
  await expect(notice(page)).toBeVisible();
  await square(page, "E8").click();
  await expect(notice(page)).toHaveCount(0);
  fixture.update(playingShogiRoom({ ...state, moveNumber: 2 }, 2));
  await expect(square(page, "F8")).toBeEnabled();
  fixture.update(playingShogiRoom(complete({ ...state, moveNumber: 2 }), 3));
  await expect(square(page, "E8")).toHaveAttribute("data-last-move", "to");
  await expect(notice(page)).toHaveCount(0);
});

test("HTTPで確認した解析対応をWebSocketへ引き継ぎ、再接続で旧Workerへ戻せる", async ({ page }) => {
  await page.clock.install({ time: now });
  const fixture = await mockRoom(page, playingShogiRoom(), true, membership, true);
  await page.goto("/rooms/12345");
  await expect(square(page, "E7")).toBeEnabled();
  await page.clock.pauseAt(now + 60000);
  expect(new URL(fixture.socketUrls[0]!).searchParams.get("formationAnalysis")).toBe("1");
  for (const supported of [false, true]) {
    fixture.setFormationAnalysisSupported(supported);
    fixture.disconnect();
    await expect(square(page, "E7")).toBeDisabled();
    await page.clock.runFor(1000);
    fixture.reconnect();
    await expect(square(page, "E7")).toBeEnabled();
    expect(new URL(fixture.socketUrls.at(-1)!).searchParams.get("formationAnalysis")).toBe(
      supported ? "1" : null,
    );
  }
});
