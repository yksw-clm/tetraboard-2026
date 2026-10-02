import { expect, test } from "bun:test";
import { createInitialState, eliminateSide, type FourShogiState } from "@tetraboard/four-shogi";
import {
  fourShogiPublicStateSchema,
  fourShogiRoomSchema,
  roomTimeControl,
  type FourShogiRoom,
} from "@tetraboard/protocol";
import {
  displayShogiGameForRoom,
  shogiCardPosition,
  shogiPlayerClock,
  shogiPlayerRank,
  shogiReplayPlayerRank,
  shogiRoomSeats,
  shogiViewerSide,
} from "../src/features/room/fourShogiRoomPresentation";

const ids = [11, 12, 13, 14].map((id) => `00000000-0000-4000-8000-0000000000${id}`);
const directions = ["east", "north", "south", "west"] as const;
function waiting(): FourShogiRoom {
  return fourShogiRoomSchema.parse({
    id: "12345",
    instanceId: "00000000-0000-4000-8000-000000000001",
    status: "waiting",
    settings: {
      game: "four-shogi",
      mode: "singles",
      timeControl: roomTimeControl,
      threePlayerAttackProhibited: true,
    },
    publicUpdatedAtMs: 0,
    lastActivityAtMs: 0,
    players: ids.map((id, index) => ({
      id,
      name: `参加者${index + 1}`,
      kind: "human",
      ready: false,
      side: null,
      reconnectDeadline: null,
    })),
    game: null,
    clock: null,
    lastRound: null,
    eliminations: [],
    roundId: null,
    positionRevision: 0,
    legalActions: [],
    checkState: { south: false, west: false, north: false, east: false },
  });
}
function initialGame(): FourShogiState {
  return createInitialState({
    mode: "singles",
    players: { south: ids[2], west: ids[3], north: ids[1], east: ids[0] },
  });
}
function playing(): FourShogiRoom {
  const room = waiting();
  const { repetitions: _repetitions, ...game } = initialGame();
  return fourShogiRoomSchema.parse({
    ...room,
    status: "playing",
    players: room.players.map((player, index) => ({ ...player, side: directions[index] })),
    game,
    roundId: "00000000-0000-4000-8000-000000000002",
    positionRevision: 0,
    clock: {
      remainingMainMs: { south: 5000, west: 0, north: 300000, east: 300000 },
      turnStartedAt: 10000,
      turnExpiresAt: 45000,
    },
  });
}

test("待機は入室順で本人が下、対局中は担当方向で本人が下、観戦は南が下", () => {
  const before = waiting();
  const waitSeats = shogiRoomSeats(before, ids[1]);
  expect([
    waitSeats.south?.id,
    waitSeats.west?.id,
    waitSeats.north?.id,
    waitSeats.east?.id,
  ]).toEqual([ids[1], ids[2], ids[3], ids[0]]);
  const room = playing();
  const seats = shogiRoomSeats(room, ids[1]);
  expect([seats.south?.id, seats.west?.id, seats.north?.id, seats.east?.id]).toEqual([
    ids[2],
    ids[3],
    ids[1],
    ids[0],
  ]);
  expect(shogiViewerSide(room, ids[1])).toBe("north");
  expect(
    ["south", "west", "north", "east"].map((side) =>
      shogiCardPosition(side as "south" | "west" | "north" | "east", "north"),
    ),
  ).toEqual(["top", "right", "bottom", "left"]);
  expect(shogiViewerSide(room, undefined)).toBe("south");
});

test("初回待機は36枚の初期盤面、再戦待機は前局の最終盤面と本人の表示方向を保持する", () => {
  const room = waiting();
  expect(displayShogiGameForRoom(room).board.flat().filter(Boolean)).toHaveLength(36);
  let state = initialGame();
  for (const side of ["south", "west", "east"] as const) {
    const result = eliminateSide(state, side, "timeout");
    if (!result.ok) throw new Error("Invalid fixed position");
    state = result.state;
  }
  const { repetitions: _repetitions, ...game } = state;
  const rematch = fourShogiRoomSchema.parse({
    ...room,
    lastRound: {
      roundId: "00000000-0000-4000-8000-000000000002",
      game,
      players: ids.map((id, index) => ({
        id,
        name: `参加者${index + 1}`,
        side: directions[index],
      })),
      eventCount: 3,
    },
  });
  expect(displayShogiGameForRoom(rematch)).toEqual(fourShogiPublicStateSchema.parse(game));
  expect(shogiViewerSide(rematch, ids[1])).toBe("north");
  const seats = shogiRoomSeats(rematch, ids[1]);
  expect(seats.north?.id).toBe(ids[1]);
  expect(shogiCardPosition("north", shogiViewerSide(rematch, ids[1]))).toBe("bottom");
  // 南の表示位置に置いた参加者は前局の西担当であり、表示位置の順位を使いません。
  expect(seats.south?.id).toBe(ids[3]);
  expect(
    shogiReplayPlayerRank(rematch, fourShogiPublicStateSchema.parse(game), seats.south?.id),
  ).toEqual({ rank: 3, label: "3位（時間切れ）" });
  expect(shogiReplayPlayerRank(rematch, fourShogiPublicStateSchema.parse(game), ids[1])).toEqual({
    rank: 1,
    label: "1位",
  });
  const { repetitions: _initialIndex, ...start } = initialGame();
  expect(
    shogiReplayPlayerRank(rematch, fourShogiPublicStateSchema.parse(start), ids[3]),
  ).toBeNull();
  expect(
    shogiReplayPlayerRank(rematch, fourShogiPublicStateSchema.parse(game), "new-player"),
  ).toBeNull();
});

test("共通時計は将棋の方向ごとに減算し、秒読み10秒/9秒を区別し、脱落した席では非表示", () => {
  expect(shogiPlayerClock(waiting(), null, 100000)).toEqual({
    text: "05:00",
    byoyomi: false,
    urgent: false,
  });
  const room = playing();
  expect(shogiPlayerClock(room, "south", 14000)).toEqual({
    text: "00:01",
    byoyomi: false,
    urgent: false,
  });
  expect(shogiPlayerClock(room, "south", 15000)).toEqual({
    text: "00:30",
    byoyomi: true,
    urgent: false,
  });
  expect(shogiPlayerClock(room, "south", 35000)).toEqual({
    text: "00:10",
    byoyomi: true,
    urgent: false,
  });
  expect(shogiPlayerClock(room, "south", 36000)).toEqual({
    text: "00:09",
    byoyomi: true,
    urgent: true,
  });
  expect(shogiPlayerClock(room, "west", 36000)).toEqual({
    text: "00:30",
    byoyomi: true,
    urgent: false,
  });
  if (room.status !== "playing") throw new Error("Expected playing");
  room.game.eliminations = [{ side: "north", reason: "checkmate", rank: 4, group: 1 }];
  expect(shogiPlayerClock(room, "north", 36000)).toBeNull();
  expect(shogiPlayerRank(room.game, "north")).toEqual({ rank: 4, label: "4位（詰み）" });
  expect(shogiPlayerRank(room.game, "south")).toBeNull();
  room.game.mode = "doubles";
  room.game.eliminations[0].rank = null;
  expect(shogiPlayerRank(room.game, "north")).toEqual({ rank: 4, label: "脱落（詰み）" });
});
