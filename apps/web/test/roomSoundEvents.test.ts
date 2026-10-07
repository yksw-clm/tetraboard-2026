import { expect, test } from "bun:test";
import {
  applyAction as placeStone,
  eliminateColor,
  getLegalMoves,
  type FourReversiState,
} from "@tetraboard/four-reversi";
import { applyAction, getLegalActions } from "@tetraboard/four-shogi";
import { fourReversiRoomSchema, type FourReversiRoom, type Room } from "@tetraboard/protocol";
import type { SoundEffect } from "../src/shared/soundPlayer";
import { RoomSoundTracker } from "../src/features/room/roomSoundEvents";
import { reversiSoundGame } from "../src/features/room/fourReversiSessionBehavior";
import { shogiSoundGame, shogiSoundMove } from "../src/features/room/fourShogiSessionBehavior";
import { playingRoom, waitingRoom } from "./fixtures/rooms";
import {
  initialShogiState,
  playingShogiRoom,
  waitingShogiRoom,
  finishedShogiRound,
  tacticalShogiState,
} from "./fixtures/fourShogiFixtures";

function movedReversi(room: FourReversiRoom): FourReversiRoom {
  if (room.status !== "playing") throw new Error("fixture");
  const moved = placeStone(room.game, {
    type: "placeStone",
    position: getLegalMoves(room.game)[0]!,
  });
  if (!moved.ok || moved.state.status !== "playing") throw new Error("fixture");
  return fourReversiRoomSchema.parse({ ...room, game: moved.state });
}
function finishedReversi(room: FourReversiRoom): FourReversiRoom {
  if (room.status !== "playing") throw new Error("fixture");
  let state: FourReversiState = room.game;
  for (const color of ["white", "red", "blue"] as const) {
    const next = eliminateColor(state, color);
    if (!next.ok) throw new Error("fixture");
    state = next.state;
  }
  if (state.status !== "finished") throw new Error("fixture");
  return fourReversiRoomSchema.parse({
    ...waitingRoom(),
    lastRound: {
      game: state,
      replay: null,
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    },
  });
}
const sounds = (...sounds: SoundEffect[]) => [{ type: "sounds" as const, sounds }];

test("両ゲームで初回・同一通知は無音、開始と再戦は一度だけ鳴る", () => {
  for (const [waiting, playing, read] of [
    [waitingRoom(), playingRoom(), reversiSoundGame],
    [waitingShogiRoom(), playingShogiRoom(), shogiSoundGame],
  ] as const) {
    const tracker = new RoomSoundTracker(read as (room: Room) => ReturnType<typeof read>);
    expect(tracker.observe(waiting, true)).toEqual([]);
    expect(tracker.observe(playing, true)).toEqual(sounds("start"));
    expect(tracker.observe(playing, true)).toEqual([]);
    tracker.observe(waiting, true);
    expect(tracker.observe(playing, true)).toEqual(sounds("start"));
    tracker.reset();
    expect(tracker.observe(playing, true)).toEqual([]);
  }
});
test("人間の新規席はjoin、CPU追加はbot、削除・準備・復帰・レベル変更は無音", () => {
  const room = waitingRoom();
  const first = { ...room, players: room.players.slice(0, 1) };
  const tracker = new RoomSoundTracker(reversiSoundGame);
  tracker.observe(first, true);
  const second = { ...room, players: room.players.slice(0, 2) };
  expect(tracker.observe(second, true)).toEqual([
    { type: "join", instanceId: room.instanceId, playerId: room.players[1]!.id },
  ]);
  expect(
    tracker.observe(
      {
        ...second,
        players: second.players.map((p) =>
          p.kind === "human" ? { ...p, ready: true, reconnectDeadline: 1 } : p,
        ),
      },
      true,
    ),
  ).toEqual([]);
  const cpu = {
    ...first,
    players: [
      ...first.players,
      {
        id: room.players[2]!.id,
        name: "CPU",
        kind: "cpu" as const,
        level: 1 as const,
        ready: true as const,
        reconnectDeadline: null,
        color: null,
      },
    ],
  };
  expect(tracker.observe(cpu, true)).toEqual(sounds("bot"));
  expect(
    tracker.observe(
      {
        ...cpu,
        players: cpu.players.map((p) => (p.kind === "cpu" ? { ...p, level: 2 as const } : p)),
      },
      true,
    ),
  ).toEqual([]);
  expect(tracker.observe(first, true)).toEqual([]);
  tracker.reset();
  expect(tracker.observe(cpu, true)).toEqual([]);
});
test("リバーシの確定着手・最終着手と終局を検出し、本人の同じ着手だけ抑止する", () => {
  const room = playingRoom(),
    moved = movedReversi(room),
    finished = finishedReversi(moved);
  const tracker = new RoomSoundTracker(reversiSoundGame);
  tracker.observe(room, true);
  tracker.recordOwnMove(room, reversiSoundGame(moved).lastMove!);
  expect(tracker.observe(moved, true)).toEqual([]);
  expect(tracker.observe(movedReversi(moved), true)).toEqual(sounds("put"));
  tracker.reset();
  tracker.observe(room, true);
  expect(tracker.observe(finished, true)).toEqual(sounds("put", "end"));
  expect(tracker.observe(finished, true)).toEqual([]);
  tracker.reset();
  tracker.observe(moved, true);
  expect(tracker.observe(finished, true)).toEqual(sounds("end"));
  tracker.reset();
  tracker.observe(room, true);
  tracker.recordOwnMove(room, "違う着手");
  expect(tracker.observe(moved, true)).toEqual(sounds("put"));
});
test("将棋はrevisionだけの変化を鳴らさず、成り・打ち駒も本人の一致した確定だけ抑止する", () => {
  const state = tacticalShogiState();
  const room = playingShogiRoom(state);
  for (const action of [
    room.legalActions.find((a) => a.type === "dropPiece")!,
    room.legalActions.find((a) => a.type === "movePiece" && a.promote)!,
  ]) {
    expect(action).toBeDefined();
    const next = applyAction(state, "south", action);
    if (!next.ok) throw new Error("fixture");
    const tracker = new RoomSoundTracker(shogiSoundGame);
    tracker.observe(room, true);
    const revision = { ...room, positionRevision: 1 };
    expect(tracker.observe(revision, true)).toEqual([]);
    tracker.recordOwnMove(revision, shogiSoundMove(action, "south"));
    const moved = playingShogiRoom(next.state, 2);
    expect(tracker.observe(moved, true)).toEqual([]);
    tracker.reset();
    tracker.observe(room, true);
    tracker.recordOwnMove(room, shogiSoundMove(action, "west"));
    expect(tracker.observe(moved, true)).toEqual(sounds("put"));
  }
});
test("将棋の最終手・終了、本人の最終手、異なる局、まとめ受信を区別する", () => {
  const room = playingShogiRoom(),
    finished = finishedShogiRound().room;
  const tracker = new RoomSoundTracker(shogiSoundGame);
  tracker.observe(room, true);
  expect(tracker.observe(finished, true)).toEqual(sounds("put", "end"));
  tracker.reset();
  tracker.observe(room, true);
  tracker.recordOwnMove(room, shogiSoundGame(finished).lastMove!);
  expect(tracker.observe(finished, true)).toEqual(sounds("end"));
  expect(tracker.observe(finished, true)).toEqual([]);
  expect(tracker.observe({ ...room, roundId: crypto.randomUUID() }, true)).toEqual(sounds("start"));
  tracker.reset();
  const first = initialShogiState();
  tracker.observe(playingShogiRoom(first), true);
  const a = applyAction(first, "south", getLegalActions(first)[0]!);
  if (!a.ok || a.state.status !== "playing") throw new Error("fixture");
  const b = applyAction(a.state, a.state.turn, getLegalActions(a.state)[0]!);
  if (!b.ok) throw new Error("fixture");
  expect(tracker.observe(playingShogiRoom(b.state, 2), true)).toEqual(sounds("put"));
});
test("非表示中・切断後・部屋世代変更では過去の音を再演しない", () => {
  const room = playingRoom(),
    moved = movedReversi(room);
  const tracker = new RoomSoundTracker(reversiSoundGame);
  tracker.observe(room, true);
  tracker.recordOwnMove(room, reversiSoundGame(moved).lastMove!);
  expect(tracker.observe(moved, false)).toEqual([]);
  expect(tracker.observe(moved, true)).toEqual([]);
  expect(tracker.observe(movedReversi(moved), true)).toEqual(sounds("put"));
  tracker.reset();
  expect(tracker.observe(finishedReversi(moved), true)).toEqual([]);
  expect(tracker.observe({ ...room, instanceId: crypto.randomUUID() }, true)).toEqual([]);
});
