import { describe, expect, test } from "bun:test";
import {
  fourReversiStateSchema,
  roomSchema,
  roomTimeControl,
  type Room,
} from "@tetraboard/protocol";
import {
  applyAction,
  createInitialState,
  eliminateColor,
  getLegalMoves,
} from "@tetraboard/four-reversi";
import {
  displayGameForRoom,
  orderedSeats,
  playerClock,
} from "../src/features/room/roomPresentation";

function waitingRoom(): Room {
  return roomSchema.parse({
    id: "12345",
    instanceId: crypto.randomUUID(),
    status: "waiting",
    settings: { game: "four-reversi", mode: "singles", timeControl: roomTimeControl },
    publicUpdatedAtMs: 0,
    lastActivityAtMs: 0,
    players: Array.from({ length: 4 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `参加者${index + 1}`,
      kind: "human",
      ready: false,
      color: null,
      reconnectDeadline: null,
    })),
    game: null,
    clock: null,
    lastRound: null,
  });
}
function playingRoom() {
  const room = waitingRoom();
  return roomSchema.parse({
    ...room,
    status: "playing",
    players: room.players.map((player, index) => ({
      ...player,
      color: ["red", "blue", "white", "black"][index],
    })),
    game: createInitialState("singles"),
    clock: {
      remainingMainMs: { black: 5000, white: 0, red: 300000, blue: 300000 },
      turnStartedAt: 10000,
      turnExpiresAt: 45000,
    },
  });
}

describe("ルームの表示", () => {
  test("最終手を持たない保存済み対局も読み込み、次の着手から座標を保持する", () => {
    const saved = { ...createInitialState("singles") };
    Reflect.deleteProperty(saved, "lastMove");
    const restored = fourReversiStateSchema.parse(saved);
    expect(restored.lastMove).toBeNull();
    const moved = applyAction(restored, { type: "placeStone", position: { x: 2, y: 3 } });
    if (!moved.ok) throw new Error("Failed to place stone");
    expect(fourReversiStateSchema.parse(moved.state).lastMove).toEqual({ x: 2, y: 3 });
  });

  test("初回待機は初期盤面、再戦待機は前局の最終盤面を表示する", () => {
    const room = waitingRoom();
    const initial = createInitialState("singles");
    expect(displayGameForRoom(room)).toEqual(initial);
    const placed = applyAction(initial, {
      type: "placeStone",
      position: getLegalMoves(initial)[0],
    });
    if (!placed.ok) throw new Error("Failed to place stone");
    let finished = placed.state;
    for (const color of ["black", "white", "red"] as const) {
      const result = eliminateColor(finished, color);
      if (!result.ok) throw new Error("Failed to finish game");
      finished = result.state;
    }
    const rematch = roomSchema.parse({
      ...room,
      lastRound: {
        game: finished,
        players: room.players.map((player, index) => ({
          id: player.id,
          name: player.name,
          color: ["black", "white", "red", "blue"][index],
        })),
      },
    });
    expect(rematch.lastRound?.game.board).not.toEqual(initial.board);
    expect(displayGameForRoom(rematch)).toEqual(finished);
    expect(rematch.lastRound?.game.status).toBe("finished");
  });

  test("対局中は入室順を保って自分を手前にし、担当色で並べ替えない", () => {
    const room = playingRoom();
    expect(orderedSeats(room, room.players[1].id).map((player) => player?.name)).toEqual([
      "参加者2",
      "参加者3",
      "参加者4",
      "参加者1",
    ]);
    expect(orderedSeats(room, undefined).map((player) => player?.name)).toEqual([
      "参加者1",
      "参加者2",
      "参加者3",
      "参加者4",
    ]);
    expect(displayGameForRoom(room)).toEqual(room.game);
  });

  test("待機中は在席者の後ろにだけ空席を追加する", () => {
    const room = waitingRoom();
    room.players.splice(1, 1);
    expect(orderedSeats(room, undefined).map((player) => player?.name ?? "空席")).toEqual([
      "参加者1",
      "参加者3",
      "参加者4",
      "空席",
    ]);
  });

  test("待機時間は初期値に戻り、秒読みは10秒と9秒で強調を切り替える", () => {
    expect(playerClock(waitingRoom(), null, 100000)).toEqual({
      text: "05:00",
      byoyomi: false,
      urgent: false,
    });
    const room = playingRoom();
    expect(playerClock(room, "black", 14000)).toEqual({
      text: "00:01",
      byoyomi: false,
      urgent: false,
    });
    expect(playerClock(room, "black", 15000)).toEqual({
      text: "00:30",
      byoyomi: true,
      urgent: false,
    });
    expect(playerClock(room, "black", 35000)).toEqual({
      text: "00:10",
      byoyomi: true,
      urgent: false,
    });
    expect(playerClock(room, "black", 36000)).toEqual({
      text: "00:09",
      byoyomi: true,
      urgent: true,
    });
    expect(playerClock(room, "white", 36000)).toEqual({
      text: "00:30",
      byoyomi: true,
      urgent: false,
    });
    if (room.status !== "playing") throw new Error("Expected playing room");
    room.game.eliminatedColors.push("red");
    expect(playerClock(room, "red", 36000)).toBeNull();
  });
});
