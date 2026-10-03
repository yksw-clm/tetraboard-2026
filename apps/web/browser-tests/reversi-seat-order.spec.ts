import { expect, test, type Page } from "@playwright/test";
import {
  applyAction,
  createInitialState,
  eliminateColor,
  type Color,
  type FourReversiState,
} from "@tetraboard/four-reversi";
import { fourReversiRoomSchema, type FourReversiRoom } from "@tetraboard/protocol";
import { mockRoom, playerIds, playingRoom, waitingRoom } from "./fixtures";
import { mockAccount, profile } from "./accountFixtures";
import { replayMatch } from "./matchReplayFixtures";

const rotationName = "盤面を時計回りに90度回転";
const positions = ["bottom", "left", "top", "right"] as const;
type Position = (typeof positions)[number];
const colorNames: Record<Color, string> = { black: "黒", white: "白", red: "赤", blue: "青" };
const observerPositions: Record<Color, Position> = {
  black: "bottom",
  white: "left",
  red: "top",
  blue: "right",
};
const bluePositions: Record<Color, Position> = {
  blue: "bottom",
  black: "left",
  white: "top",
  red: "right",
};
const redPositions: Record<Color, Position> = {
  red: "bottom",
  blue: "left",
  black: "top",
  white: "right",
};

function parsePlayingRoom(value: unknown) {
  const room = fourReversiRoomSchema.parse(value);
  if (room.status !== "playing") throw new Error("Expected playing fixture");
  return room;
}

function shuffledRoom(mode: "singles" | "doubles") {
  const room = playingRoom();
  if (room.status !== "playing") throw new Error("Expected playing fixture");
  const assignment: Color[] = ["red", "blue", "white", "black"];
  return parsePlayingRoom({
    ...room,
    settings: { ...room.settings, mode },
    game: createInitialState(mode),
    players: room.players.map((p, i) =>
      i >= 2
        ? {
            id: p.id,
            name: p.name,
            kind: "cpu",
            level: i === 2 ? 1 : 2,
            ready: true,
            reconnectDeadline: null,
            color: assignment[i],
          }
        : { ...p, color: assignment[i] },
    ),
    clock: {
      ...room.clock,
      remainingMainMs: { black: 60000, white: 120000, red: 180000, blue: 240000 },
    },
  });
}

type CardPlayer = { name: string; color: Color; kind: "human" | "cpu"; level?: number };
function card(page: Page, player: CardPlayer) {
  const name = player.kind === "cpu" ? `CPU Lv${player.level}` : player.name;
  return page.getByTestId("player-card").filter({ hasText: name });
}

async function expectPositions(
  page: Page,
  players: CardPlayer[],
  initial: Record<Color, Position>,
  rotation = 0,
  showColors = true,
) {
  const board = await page
    .getByRole("group", { name: "四人リバーシの盤面", exact: true })
    .boundingBox();
  if (!board) throw new Error("Board missing");
  for (const player of players) {
    const element = card(page, player);
    const position = positions[(positions.indexOf(initial[player.color]) + rotation) % 4];
    await expect(element).toBeVisible();
    await expect.poll(() => element.evaluate((el) => getComputedStyle(el).gridArea)).toBe(position);
    if (showColors)
      await expect(element.getByTestId("player-stone-count")).toHaveAccessibleName(
        new RegExp(`^${colorNames[player.color]}(?:、|$)`),
      );
    const box = await element.boundingBox();
    if (!box) throw new Error("Card missing");
    if (page.viewportSize()!.width <= 767) {
      expect(box.x + box.width / 2 > board.x + board.width / 2).toBe(
        position === "top" || position === "right",
      );
      expect(box.y + box.height / 2 > board.y + board.height / 2).toBe(
        position === "bottom" || position === "right",
      );
    } else {
      if (position === "top") expect(box.y + box.height / 2).toBeLessThan(board.y);
      if (position === "bottom")
        expect(box.y + box.height / 2).toBeGreaterThan(board.y + board.height);
      if (position === "left") expect(box.x + box.width / 2).toBeLessThan(board.x);
      if (position === "right")
        expect(box.x + box.width / 2).toBeGreaterThan(board.x + board.width);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const width of [320, 390, 767, 768, 1280, 1440]) {
  for (const mode of ["singles", "doubles"] as const) {
    for (const audience of ["観戦", "対局者", "保存棋譜"] as const) {
      test(`${mode} ${audience} ${width}px: シャッフル配色の4席と回転が手番順に並ぶ`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.route("**/api/analytics/**", (route) => route.fulfill({ status: 204 }));
        let players: CardPlayer[];
        let expected: Record<Color, Position>;
        if (audience === "保存棋譜") {
          await mockAccount(page, profile);
          const match = replayMatch(mode);
          match.participants = match.participants.map((p, i) => ({
            ...p,
            color: (["white", "blue", "red", "black"] as Color[])[i],
          }));
          match.selfPlayerId = match.participants[2].id;
          // 実際の閲覧者は人間。CPUを含む過去棋譜でも席番号は表示位置に使わない。
          match.participants[2] = {
            ...match.participants[0],
            id: match.selfPlayerId,
            name: "棋譜の本人",
            color: "red",
            seat: 2,
          };
          players = match.participants;
          expected = redPositions;
          await page.route("**/api/account/matches/*", (route) =>
            route.fulfill({ json: { match } }),
          );
          await page.goto(`/account/matches/${match.id}`);
          await expect(page.getByText("棋譜閲覧中", { exact: true })).toBeVisible();
          await expect(card(page, players[0])).toHaveAccessibleName(`${players[0].name}、ホスト`);
        } else {
          const room = shuffledRoom(mode);
          players = room.players;
          expected = audience === "観戦" ? observerPositions : bluePositions;
          await mockRoom(page, room, audience === "対局者", {
            playerId: playerIds[1],
            role: "player",
          });
          await page.goto("/rooms/12345");
          await expect(page.getByText("CPU Lv2の番です。", { exact: true })).toBeVisible();
          for (const player of players) {
            const clock = { black: "01:00", white: "02:00", red: "03:00", blue: "04:00" }[
              player.color
            ];
            await expect(
              card(page, player).getByLabel(`持ち時間 ${clock}`, { exact: true }),
            ).toBeVisible();
            await expect(card(page, player).getByTestId("player-stone-count")).toHaveAccessibleName(
              `${colorNames[player.color]}、2石`,
            );
          }
          await expect(card(page, players[0])).toHaveAccessibleName(`${players[0].name}、ホスト`);
        }
        await expectPositions(page, players, expected);
        if (audience === "対局者") {
          await expect(card(page, players[1])).toHaveAccessibleName(`${players[1].name}、あなた`);
          await expect(page.getByRole("button", { name: rotationName })).toHaveCount(0);
        } else {
          for (let rotation = 1; rotation <= 4; rotation++) {
            await page.getByRole("button", { name: rotationName }).click();
            await expectPositions(page, players, expected, rotation % 4);
          }
          if (audience === "保存棋譜") {
            await page.getByRole("button", { name: "棋譜を1つ戻る", exact: true }).click();
            await expectPositions(page, players, expected);
          }
          await page.reload();
          await expectPositions(page, players, expected);
        }
        if (mode === "singles" && width === 390)
          await page.screenshot({ path: info.outputPath(`${audience}.png`) });
      });
    }
  }
}

test("シャッフル配色を脱落・ホスト退室・切断復帰で保持し、再戦待機と再抽選へ切り替える", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.route("**/api/analytics/**", (route) => route.fulfill({ status: 204 }));
  let room = shuffledRoom("singles");
  const fixture = await mockRoom(page, room, false);
  await page.goto("/rooms/12345");
  const players = room.players;
  await expectPositions(page, players, observerPositions);
  const placed = applyAction(room.game, { type: "placeStone", position: { x: 2, y: 3 } });
  if (!placed.ok) throw new Error("Invalid move fixture");
  room = parsePlayingRoom({ ...room, game: placed.state });
  fixture.update(room);
  await expect(page.getByText("CPU Lv1の番です。", { exact: true })).toBeVisible();
  await expect(card(page, players[3]).getByTestId("player-stone-count")).toHaveAccessibleName(
    "黒、4石",
  );
  const eliminated = eliminateColor(room.game, "red");
  if (!eliminated.ok) throw new Error("Invalid elimination fixture");
  room = parsePlayingRoom({
    ...room,
    game: eliminated.state,
    eliminations: [{ color: "red", reason: "left" }],
  });
  fixture.update(room, { hostPlayerId: playerIds[0], connectedPlayerIds: [playerIds[1]] });
  await expect(card(page, players[0]).getByText("4位（退室）", { exact: true })).toBeVisible();
  await expect(card(page, players[0]).getByLabel("切断中", { exact: true })).toBeVisible();
  await expectPositions(page, players, observerPositions);
  await page.getByRole("button", { name: rotationName }).click();
  fixture.disconnect();
  await expect(page.getByText("再接続中", { exact: true })).toBeVisible();
  fixture.reconnect();
  await expect(page.getByText("再接続中", { exact: true })).toHaveCount(0);
  await expectPositions(page, players, observerPositions, 1);
  let finished: FourReversiState = room.game;
  for (const color of ["white", "black"] as const) {
    const result = eliminateColor(finished, color);
    if (!result.ok) throw new Error("Invalid final fixture");
    finished = result.state;
  }
  const waiting: FourReversiRoom = fourReversiRoomSchema.parse({
    ...waitingRoom(),
    players: [players[1], players[2], players[3]].map((p) => ({
      ...p,
      color: null,
      ready: p.kind === "cpu",
    })),
    lastRound: {
      game: finished,
      players: players.map(({ id, name, color }) => ({ id, name, color })),
    },
  });
  fixture.update(waiting, { hostPlayerId: playerIds[1], connectedPlayerIds: [playerIds[1]] });
  await expect(page.getByRole("button", { name: "結果", exact: true })).toBeVisible();
  for (const [index, player] of players.slice(1).entries()) {
    await expect
      .poll(() => card(page, player).evaluate((el) => getComputedStyle(el).gridArea))
      .toBe(positions[(index + 1) % 4]);
    await expect(card(page, player).getByTestId("player-stone-count")).toHaveCount(0);
  }
  await expect(card(page, players[1])).toHaveAccessibleName(`${players[1].name}、ホスト`);
  await expect(page.getByLabel("空席", { exact: true })).toBeVisible();
  const next = shuffledRoom("singles");
  next.players = next.players.map((p, i) => ({
    ...p,
    color: (["white", "red", "black", "blue"] as Color[])[i],
  }));
  fixture.update(next);
  await expectPositions(page, next.players, observerPositions, 1);
  expect(fixture.received).toEqual([]);
});
