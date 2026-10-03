import { expect, test, type Page, type Locator } from "@playwright/test";
import { mockRoom, playingRoom, waitingRoom, playerIds } from "./fixtures";
import { playingShogiRoom, waitingShogiRoom, finishedShogiRound } from "./fourShogiFixtures";
import { mockAccount, profile } from "./accountFixtures";
import { replayMatch } from "./matchReplayFixtures";
import { shogiReplayMatch } from "./fourShogiRecordFixtures";
import { roomSchema } from "@tetraboard/protocol";

const rotateName = "盤面を時計回りに90度回転";
const positions = ["bottom", "left", "top", "right", "bottom"];

async function expectCorner(board: Locator, cell: Locator, corner: number) {
  const area = await board.boundingBox();
  const square = await cell.boundingBox();
  if (!area || !square) throw new Error("Board missing");
  const right = corner === 1 || corner === 2;
  const bottom = corner === 2 || corner === 3;
  expect(square.x + square.width / 2 > area.x + area.width / 2).toBe(right);
  expect(square.y + square.height / 2 > area.y + area.height / 2).toBe(bottom);
}

async function expectControlsFit(page: Page) {
  const status = await page.getByLabel("対局状況", { exact: true }).boundingBox();
  const rotate = await page.getByRole("button", { name: rotateName }).boundingBox();
  if (!status || !rotate) throw new Error("Controls missing");
  expect(rotate.y).toBeGreaterThanOrEqual(status.y);
  expect(rotate.y + rotate.height).toBeLessThanOrEqual(status.y + status.height + 1);
  expect(rotate.width).toBe(38);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function boardContents(board: Locator) {
  return board.getByRole("button").evaluateAll((cells) =>
    cells
      .map((cell) => ({
        label: cell.getAttribute("aria-label")!,
        direction:
          cell.querySelector("[data-piece-direction]")?.getAttribute("data-piece-direction") ??
          null,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );
}

for (const game of ["four-reversi", "four-shogi"] as const) {
  for (const width of [320, 390, 768, 1440]) {
    for (const saved of [false, true]) {
      test(`${game} ${saved ? "保存棋譜" : "観戦"}を回転する ${width}px`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 950 });
        let playerName: string;
        let baseCorner = 0;
        if (saved) {
          await mockAccount(page, profile);
          const shogi = shogiReplayMatch();
          const match = game === "four-shogi" ? shogi.detail : replayMatch();
          playerName = match.participants.find((player) => player.id === match.selfPlayerId)!.name;
          baseCorner = game === "four-shogi" ? 2 : 0;
          await page.route(/\/api\/account\/matches\/[^/?]+$/, (route) =>
            route.fulfill({ json: { match } }),
          );
          if (game === "four-shogi")
            await page.route(/\/api\/account\/matches\/[^/?]+\/replay(?:\?.*)?$/, (route) =>
              route.fulfill({
                json: shogi.page(
                  Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0),
                ),
              }),
            );
          await page.goto(`/account/matches/${match.id}`);
        } else {
          const room = game === "four-shogi" ? playingShogiRoom() : playingRoom();
          playerName = room.players[0]!.name;
          await mockRoom(page, room, false);
          await page.goto("/rooms/12345");
        }
        const board = page.getByRole("group", {
          name: game === "four-shogi" ? "四人将棋の盤面" : "四人リバーシの盤面",
          exact: true,
        });
        const cell = board.getByRole("button", { name: /^A1：/ });
        const player = page.getByTestId("player-card").filter({ hasText: playerName });
        const rotate = page.getByRole("button", { name: rotateName });
        await expect(
          page.getByText(saved ? "棋譜閲覧中" : "観戦中", { exact: true }),
        ).toBeVisible();
        await expect(player).toHaveCount(1);
        for (let turn = 0; turn <= 4; turn++) {
          await expectCorner(board, cell, (baseCorner + turn) % 4);
          expect(await player.evaluate((element) => getComputedStyle(element).gridArea)).toBe(
            positions[turn],
          );
          await expectControlsFit(page);
          if (game === "four-shogi") {
            const side = saved ? "北" : "南";
            const hand = page.getByRole("group", { name: `${side}の持ち駒`, exact: true });
            expect(
              await hand
                .locator("xpath=ancestor::*[@data-board-position][1]")
                .getAttribute("data-board-position"),
            ).toBe(positions[turn]);
          }
          if (turn === 1) {
            await page.screenshot({ path: info.outputPath("rotated.png") });
            if (width < 1280) {
              await page.getByRole("tab", { name: "ルーム", exact: true }).click();
              await page.getByRole("tab", { name: "盤面", exact: true }).click();
              await expectCorner(board, cell, (baseCorner + turn) % 4);
            }
            if (saved) {
              await page.getByRole("button", { name: "棋譜を1つ戻る", exact: true }).click();
              await expectCorner(board, cell, (baseCorner + turn) % 4);
            }
          }
          if (turn < 4) {
            const before = await boardContents(board);
            if (turn === 0) {
              await rotate.focus();
              await page.keyboard.press("Enter");
            } else await rotate.click();
            const clockwise: Record<string, string> = {
              up: "right",
              right: "down",
              down: "left",
              left: "up",
            };
            await expect
              .poll(() => boardContents(board))
              .toEqual(
                before.map((cell) => ({
                  ...cell,
                  direction: cell.direction ? clockwise[cell.direction] : null,
                })),
              );
          }
        }
        for (const square of await board.getByRole("button").all())
          await expect(square).toBeDisabled();
        await page.reload();
        await expectCorner(board, cell, baseCorner);
      });
    }
  }
  test(`${game} 空席から参加でき、参加者の盤と直前局棋譜には回転を表示しない`, async ({ page }) => {
    const room = game === "four-shogi" ? waitingShogiRoom() : waitingRoom();
    const entrant = room.players[1]!;
    room.players = room.players.slice(0, 1);
    const identity = { playerId: playerIds[1]!, role: "player" as const };
    const fixture = await mockRoom(page, room, false, identity);
    await page.route("**/api/rooms/12345/players", (route) => {
      const joined = roomSchema.parse({ ...room, players: [...room.players, entrant] });
      fixture.update(joined);
      return route.fulfill({
        json: { room: joined, membership: { ...identity, token: "b".repeat(64) } },
      });
    });
    await page.goto("/rooms/12345");
    await expect(page.getByText("観戦中", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: rotateName }).click();
    await page.getByRole("button", { name: "参加する", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "ニックネーム" }).fill("参加者2");
    await dialog.getByRole("button", { name: "参加する", exact: true }).click();
    await expect(page.getByRole("button", { name: "準備完了", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: rotateName })).toHaveCount(0);
    const board = page.getByRole("group", {
      name: game === "four-shogi" ? "四人将棋の盤面" : "四人リバーシの盤面",
      exact: true,
    });
    await expectCorner(board, board.getByRole("button", { name: /^A1：/ }), 0);
    const participant = page.getByTestId("player-card").filter({ hasText: entrant.name });
    expect(await participant.evaluate((element) => getComputedStyle(element).gridArea)).toBe(
      "bottom",
    );
    const shogiRound = finishedShogiRound();
    await page.route("**/api/rooms/12345/rounds/*/replay?*", (route) =>
      route.fulfill({
        json: {
          instanceId: shogiRound.room.instanceId,
          roundId: shogiRound.room.lastRound!.roundId,
          rulesVersion: 1,
          initial: {
            mode: "singles",
            players: playingShogiRoom().game.players,
            threePlayerAttackProhibited: true,
          },
          eventCount: shogiRound.events.length,
          events: shogiRound.events,
          nextCursor: null,
        },
      }),
    );
    const ended =
      game === "four-shogi"
        ? shogiRound.room
        : {
            ...waitingRoom(),
            lastRound: {
              game: replayMatch().game,
              players: replayMatch().participants.map(({ id, name, color }) => ({
                id,
                name,
                color,
              })),
              replay: replayMatch().replay,
            },
          };
    fixture.update(ended);
    await expect(page.getByRole("button", { name: "結果", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "棋譜を1つ戻る", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: rotateName })).toHaveCount(0);
  });

  test(`${game} 観戦の回転を再接続と次局開始で保つ`, async ({ page }) => {
    const playing = game === "four-shogi" ? playingShogiRoom() : playingRoom();
    const fixture = await mockRoom(page, playing, false);
    await page.goto("/rooms/12345");
    const board = page.getByRole("group", {
      name: game === "four-shogi" ? "四人将棋の盤面" : "四人リバーシの盤面",
      exact: true,
    });
    const cell = board.getByRole("button", { name: /^A1：/ });
    await page.getByRole("button", { name: rotateName }).click();
    await expectCorner(board, cell, 1);
    fixture.disconnect();
    await expect(page.getByText("再接続中", { exact: true })).toBeVisible();
    fixture.reconnect();
    await expect(page.getByText("再接続中", { exact: true })).toHaveCount(0);
    await expectCorner(board, cell, 1);
    fixture.update(game === "four-shogi" ? waitingShogiRoom() : waitingRoom());
    await expect(page.getByText("待機中です。", { exact: true })).toBeVisible();
    await expectCorner(board, cell, 1);
    fixture.update(
      game === "four-shogi"
        ? { ...playingShogiRoom(), roundId: "00000000-0000-4000-8000-000000000021" }
        : playingRoom(),
    );
    await expect(page.getByText(/の番です。/, { exact: true })).toBeVisible();
    await expectCorner(board, cell, 1);
    expect(fixture.received).toEqual([]);
  });
}
