import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createInitialState as gomokuInitialState } from "@tetraboard/gomoku";
import { createInitialState } from "@tetraboard/reversi";
import { createInitialState as fourReversiInitialState } from "@tetraboard/four-reversi";
import { createInitialState as fourShogiInitialState } from "@tetraboard/four-shogi";
import {
  roomSchema,
  reversiRoomSchema,
  gomokuRoomSchema,
  fourReversiRoomSchema,
  type Room,
} from "@tetraboard/protocol";
import { useRoomTransport } from "../src/features/room/useRoomTransport";
import { commonSettingsComplete } from "../src/features/room/roomSettingsCompletion";
import { roomSounds } from "../src/shared/soundEffects";
import { saveRoomMembershipToken } from "../src/shared/roomMembership";
import { membership, now, token, waitingRoom, playingRoom } from "../test/fixtures/rooms";
import { playingShogiRoom, initialShogiState } from "../test/fixtures/fourShogiFixtures";
import { standardPlayingRoom } from "../test/fixtures/standardShogiFixtures";
import { act, clock, flush, renderHook, requests, wrap } from "./harness";
import { installSocket, Socket } from "./socket";

function standardReversiRoom() {
  const base = waitingRoom();
  return reversiRoomSchema.parse({
    ...base,
    status: "playing",
    settings: { game: "reversi", timeControl: base.settings.timeControl },
    players: base.players.slice(0, 2).map((p, i) => ({ ...p, color: i ? "white" : "black" })),
    game: createInitialState(),
    clock: {
      remainingMainMs: { black: 300000, white: 300000 },
      turnStartedAt: now,
      turnExpiresAt: now + 330000,
    },
  });
}
function gomokuPlayingRoom() {
  const base = standardReversiRoom();
  return gomokuRoomSchema.parse({
    ...base,
    settings: { game: "gomoku", forbiddenRules: true, timeControl: base.settings.timeControl },
    game: gomokuInitialState(),
    roundId: "a0000000-0000-4000-8000-000000000001",
    positionRevision: 0,
  });
}
function doublesReversi() {
  const room = playingRoom();
  if (room.status !== "playing") throw Error("fixture");
  return fourReversiRoomSchema.parse({
    ...room,
    settings: { ...room.settings, mode: "doubles" },
    game: fourReversiInitialState("doubles"),
  });
}
function doublesShogi() {
  return playingShogiRoom(
    fourShogiInitialState({ mode: "doubles", players: initialShogiState().players }),
  );
}
const games = [
  playingRoom,
  playingShogiRoom,
  standardReversiRoom,
  standardPlayingRoom,
  gomokuPlayingRoom,
  doublesReversi,
  doublesShogi,
];
const isRoom = (room: Room): room is Room => roomSchema.safeParse(room).success;
const errorMessage = () => undefined;
const actionComplete = () => false;
function readSoundGame(room: Room) {
  return {
    phase: room.status,
    roundId: "roundId" in room ? room.roundId : null,
    moveNumber: room.game?.moveNumber ?? 0,
    lastMove: null,
  };
}
function mount(room: Room, spectator = false) {
  if (!spectator) saveRoomMembershipToken(room.id, token);
  return renderHook(
    useRoomTransport<Room>,
    {
      initialRoom: room,
      initialMembership: spectator ? null : membership,
      initialServerNowMs: now + clock.now,
      initialPresence: {
        hostPlayerId: membership.playerId,
        connectedPlayerIds: room.players.map((p) => p.id),
      },
      isRoom,
      actionComplete,
      settingsComplete: commonSettingsComplete,
      gameOperationError: errorMessage,
      readSoundGame,
    },
    wrap(),
  );
}
function connect(room: Room, spectator = false) {
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room, now + clock.now);
  if (!spectator) socket.receive({ type: "room.authenticated", membership });
  return socket;
}
function shortClock<T extends Room>(room: T, duration = 10_000) {
  if (room.status !== "playing") throw Error("fixture");
  room.settings.timeControl = { mainTimeMs: 0, byoyomiMs: 10_000 };
  room.clock.turnStartedAt = now + clock.now;
  room.clock.turnExpiresAt = now + clock.now + duration;
  for (const seat of Object.keys(room.clock.remainingMainMs))
    (room.clock.remainingMainMs as Record<string, number>)[seat] = 0;
  return room;
}

let restore: () => void;
let playClock: ReturnType<typeof spyOn<typeof roomSounds, "playClock">>;
let stopClock: ReturnType<typeof spyOn<typeof roomSounds, "stopClock">>;
beforeEach(() => {
  restore = installSocket();
  roomSounds.setEnabled(true);
  playClock = spyOn(roomSounds, "playClock").mockImplementation(() => {});
  stopClock = spyOn(roomSounds, "stopClock").mockImplementation(() => {});
});
afterEach(() => {
  playClock.mockRestore();
  stopClock.mockRestore();
  restore();
  roomSounds.setEnabled(true);
});

test("全4ゲームの本人だけに5秒で1回通知し、同じ通知・同期補正・手番外では繰り返さない", () => {
  for (const makeRoom of games) {
    const room = shortClock(makeRoom());
    const h = mount(room);
    const socket = connect(room);
    clock.advance(4750);
    expect(playClock).not.toHaveBeenCalled();
    clock.advance(250);
    expect(playClock).toHaveBeenLastCalledWith(5000);
    socket.snapshot(room, now + clock.now - 1000);
    clock.advance(1000);
    expect(playClock).toHaveBeenCalledTimes(1);
    const other = structuredClone(room);
    if (other.status !== "playing") throw Error("fixture");
    other.game.turn = "color" in other.players[1]! ? "white" : "north";
    other.clock.turnStartedAt++;
    socket.snapshot(other, now + clock.now);
    expect(stopClock).toHaveBeenCalled();
    clock.advance(500);
    expect(playClock).toHaveBeenCalledTimes(1);
    h.unmount();
    playClock.mockClear();
  }
});

test("全4ゲームで短い新手番は即時通知、初回5秒以下・観戦・CPUでは鳴らない", () => {
  for (const makeRoom of games) {
    const room = shortClock(makeRoom(), 4000);
    const h = mount(room);
    const socket = connect(room);
    expect(playClock).not.toHaveBeenCalled();
    if (room.status !== "playing") throw Error("fixture");
    const next = structuredClone(room);
    if (next.status !== "playing") throw Error("fixture");
    next.game.moveNumber++;
    next.clock.turnStartedAt++;
    socket.snapshot(next, now + clock.now);
    expect(playClock).toHaveBeenLastCalledWith(4000);
    h.unmount();
    playClock.mockClear();
    const viewer = mount(room, true);
    connect(room, true).snapshot(next, now + clock.now);
    expect(playClock).not.toHaveBeenCalled();
    viewer.unmount();
    const cpuRoom = structuredClone(next);
    const first = cpuRoom.players[0]!;
    cpuRoom.players[0] = { ...first, kind: "cpu", level: 1 } as typeof first;
    const cpu = mount(cpuRoom);
    connect(cpuRoom).snapshot({
      ...cpuRoom,
      clock: { ...next.clock, turnStartedAt: now + 1 },
    } as Room);
    expect(playClock).not.toHaveBeenCalled();
    cpu.unmount();
  }
});

test("持ち時間＋秒読みは持ち時間終了5秒前に鳴らさず、秒読みなしは持ち時間5秒前に鳴る", () => {
  for (const byoyomiMs of [0, 10_000] as const) {
    const room = shortClock(playingRoom(), 60_000 + byoyomiMs);
    if (room.status !== "playing") throw Error("fixture");
    room.settings.timeControl = { mainTimeMs: 60_000, byoyomiMs };
    room.clock.remainingMainMs.black = 60_000;
    const h = mount(room);
    connect(room);
    clock.advance(55_000);
    expect(playClock).toHaveBeenCalledTimes(byoyomiMs === 0 ? 1 : 0);
    if (byoyomiMs) {
      clock.advance(10_000);
      expect(playClock).toHaveBeenLastCalledWith(5000);
    }
    h.unmount();
    playClock.mockClear();
  }
});

test("着手/投了送信成功で停止・消費し、送信失敗では継続、拒否後に再演しない", () => {
  for (const resign of [false, true]) {
    const room = shortClock(playingRoom());
    const h = mount(room);
    const socket = connect(room);
    clock.advance(5000);
    stopClock.mockClear();
    socket.failSend = true;
    act(() =>
      expect(
        h.current.sendGameMessage(
          { type: "room.game.resign" },
          { type: "resign", participant: "black" },
        ),
      ).toBe(false),
    );
    expect(stopClock).not.toHaveBeenCalled();
    socket.failSend = false;
    act(() => {
      const sent = resign
        ? h.current.sendGameMessage(
            { type: "room.game.resign" },
            { type: "resign", participant: "black" },
          )
        : h.current.sendGameMessage(
            { type: "room.game.action", action: { type: "placeStone", position: { x: 2, y: 3 } } },
            { type: "move", moveNumber: 0 },
          );
      expect(sent).toBe(true);
    });
    expect(stopClock).toHaveBeenCalledTimes(1);
    socket.receive({ type: "room.error", error: "invalid_move" });
    clock.advance(250);
    expect(playClock).toHaveBeenCalledTimes(1);
    h.unmount();
    playClock.mockClear();
  }
});

test("非表示・復旧同期・再認証では停止し、遅い取得と旧通知で通知済みを解除しない", async () => {
  const room = shortClock(playingRoom());
  const h = mount(room);
  const socket = connect(room);
  clock.advance(5000);
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    const visible = (value: string) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
    };
    stopClock.mockClear();
    visible("hidden");
    expect(stopClock).toHaveBeenCalled();
    clock.advance(500);
    visible("visible");
    requests.at(-1)!.respond({ room, presence: h.current.presence, serverNowMs: now + 5500 });
    await flush();
    requests.at(-1)!.respond(membership);
    await flush();
    socket.receive({ type: "room.authenticated", membership });
    socket.snapshot(room, now + 4000);
    clock.advance(1000);
    expect(playClock).toHaveBeenCalledTimes(1);
    act(() => socket.close());
    clock.advance(1000);
    requests.at(-1)!.respond({ room, presence: h.current.presence, serverNowMs: now + clock.now });
    await flush();
    requests.at(-1)!.respond(membership);
    await flush();
    connect(room);
    clock.advance(250);
    expect(playClock).toHaveBeenCalledTimes(1);
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
    h.unmount();
  }
});

test("効果音OFFから5秒以下でONに戻しても再演せず、終局・退室・離脱で停止", () => {
  const room = shortClock(playingRoom());
  const h = mount(room);
  const socket = connect(room);
  clock.advance(4900);
  roomSounds.setEnabled(false);
  // 次のtickより前に5秒をまたいでONに戻す場合も、基準から見送ります。
  clock.now += 200;
  roomSounds.setEnabled(true);
  clock.advance(250);
  expect(playClock).not.toHaveBeenCalled();
  stopClock.mockClear();
  socket.snapshot(waitingRoom(), now + clock.now);
  expect(stopClock).toHaveBeenCalled();
  act(() => {
    void h.current.handleLeaveClick();
  });
  expect(stopClock).toHaveBeenCalled();
  h.unmount();
  expect(stopClock).toHaveBeenCalled();
});

test("同一人物の秒読みリセットと再戦では、新しいカウントの5秒をそれぞれ通知", () => {
  const room = shortClock(playingRoom());
  const h = mount(room);
  const socket = connect(room);
  clock.advance(5000);
  expect(playClock).toHaveBeenCalledTimes(1);
  if (room.status !== "playing") throw Error("fixture");
  const next = shortClock(structuredClone(room));
  next.game.moveNumber += 2;
  socket.snapshot(next, now + clock.now);
  clock.advance(5000);
  expect(playClock).toHaveBeenCalledTimes(2);
  socket.snapshot(waitingRoom(), now + clock.now);
  const rematch = shortClock(playingRoom());
  socket.snapshot(rematch, now + clock.now);
  clock.advance(5000);
  expect(playClock).toHaveBeenCalledTimes(3);
  h.unmount();
});

test("表示復帰・再認証の基準に5秒より多く残っていれば未来の境界を通知", async () => {
  const room = shortClock(playingRoom());
  const h = mount(room);
  const socket = connect(room);
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    clock.advance(2500);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    clock.advance(1000);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    requests.at(-1)!.respond({ room, presence: h.current.presence, serverNowMs: now + clock.now });
    await flush();
    requests.at(-1)!.respond(membership);
    await flush();
    clock.advance(1000);
    expect(playClock).not.toHaveBeenCalled();
    socket.receive({ type: "room.authenticated", membership });
    clock.advance(500);
    expect(playClock).toHaveBeenLastCalledWith(5000);
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
    h.unmount();
  }
});
