import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { applyAction as placeStone, getLegalMoves } from "@tetraboard/four-reversi";
import { applyAction } from "@tetraboard/four-shogi";
import { StrictMode, createElement, type ReactNode } from "react";
import { fourReversiRoomSchema, type Room } from "@tetraboard/protocol";
import { useRoomSession } from "../src/features/room/useRoomSession";
import { useFourShogiRoomSession } from "../src/features/room/useFourShogiRoomSession";
import { useRoomEntry } from "../src/features/lobby/useRoomEntry";
import { useRoomInvitation } from "../src/features/room/useRoomInvitation";
import { roomSounds } from "../src/shared/soundEffects";
import { saveRoomMembershipToken } from "../src/shared/roomMembership";
import {
  membership,
  now,
  playerIds,
  token,
  waitingRoom,
  playingRoom,
} from "../test/fixtures/rooms";
import {
  playingShogiRoom,
  waitingShogiRoom,
  initialShogiState,
  finishedShogiRound,
} from "../test/fixtures/fourShogiFixtures";
import { act, clock, flush, renderHook, requests, wrap } from "./harness";
import { installSocket, Socket } from "./socket";

let restoreSocket: () => void;
let play: ReturnType<typeof spyOn<typeof roomSounds, "play">>;
let join: ReturnType<typeof spyOn<typeof roomSounds, "playJoin">>;
beforeEach(() => {
  restoreSocket = installSocket();
  play = spyOn(roomSounds, "play").mockImplementation(() => {});
  join = spyOn(roomSounds, "playJoin").mockImplementation(() => {});
});
afterEach(() => {
  restoreSocket();
  play.mockRestore();
  join.mockRestore();
});
function options<T extends Room>(room: T, spectator = false) {
  if (!spectator) saveRoomMembershipToken(room.id, token);
  return {
    initialRoom: room,
    initialMembership: spectator ? null : membership,
    initialServerNowMs: now,
    initialPresence: { hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds },
  };
}
function connect(room: Room, spectator = false) {
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room);
  if (!spectator) socket.receive({ type: "room.authenticated", membership });
  return socket;
}

test("観戦中も参加・CPU追加・開始を受信順に鳴らし、初回・重複・StrictMode再マウントは無音", () => {
  for (const game of ["four-reversi", "four-shogi"] as const) {
    const waiting = game === "four-reversi" ? waitingRoom() : waitingShogiRoom();
    waiting.players = waiting.players.slice(0, 1);
    const wrapper = wrap();
    const strict = (child: ReactNode) => wrapper(createElement(StrictMode, null, child));
    const h =
      game === "four-reversi"
        ? renderHook(useRoomSession, options(waitingRoom(), true), strict)
        : renderHook(useFourShogiRoomSession, options(waitingShogiRoom(), true), strict);
    const socket = connect(waiting, true);
    expect(play).not.toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
    const humans = game === "four-reversi" ? waitingRoom() : waitingShogiRoom();
    socket.snapshot(humans);
    expect(join).toHaveBeenCalledTimes(3);
    socket.snapshot(humans);
    expect(join).toHaveBeenCalledTimes(3);
    const base = humans.players[3]!;
    const cpu = {
      ...humans,
      players: [
        ...humans.players.slice(0, 3),
        {
          id: crypto.randomUUID(),
          name: base.name,
          kind: "cpu",
          level: 1,
          ready: true,
          reconnectDeadline: null,
          ...(game === "four-reversi" ? { color: null } : { side: null }),
        },
      ],
    } as typeof humans;
    socket.snapshot(cpu);
    expect(play.mock.calls.map(([s]) => s)).toEqual([["bot"]]);
    const playing = game === "four-reversi" ? playingRoom() : playingShogiRoom();
    // 開始後も同じ席を維持します。
    playing.players = playing.players.map((p, i) => ({
      ...p,
      id: cpu.players[i]!.id,
    })) as typeof playing.players;
    if (
      playing.settings.game === "four-shogi" &&
      "roundId" in playing &&
      playing.status === "playing"
    ) {
      for (const p of playing.players) if ("side" in p) playing.game.players[p.side] = p.id;
    }
    socket.snapshot(playing);
    socket.snapshot(playing);
    expect(play.mock.calls.map(([s]) => s)).toEqual([["bot"], ["start"]]);
    h.unmount();
    play.mockClear();
    join.mockClear();
  }
});
test("自分の合法手送信直後に鳴り、確定は無音、次の他人の手を鳴らす", () => {
  const room = playingRoom();
  if (room.status !== "playing") throw new Error("fixture");
  const h = renderHook(useRoomSession, options(room), wrap());
  const socket = connect(room);
  const position = getLegalMoves(room.game)[0]!;
  act(() => {
    h.current.handlePlaceStone({ x: -1, y: -1 });
  });
  expect(play).not.toHaveBeenCalled();
  act(() => {
    h.current.handlePlaceStone(position);
    h.current.handlePlaceStone(position);
  });
  expect(play.mock.calls.map(([s]) => s)).toEqual([["put"]]);
  const moved = placeStone(room.game, { type: "placeStone", position });
  if (!moved.ok || moved.state.status !== "playing") throw new Error("fixture");
  socket.snapshot(fourReversiRoomSchema.parse({ ...room, game: moved.state }));
  expect(play).toHaveBeenCalledTimes(1);
  const other = placeStone(moved.state, {
    type: "placeStone",
    position: getLegalMoves(moved.state)[0]!,
  });
  if (!other.ok || other.state.status !== "playing") throw new Error("fixture");
  socket.snapshot(fourReversiRoomSchema.parse({ ...room, game: other.state }));
  expect(play.mock.calls.map(([s]) => s)).toEqual([["put"], ["put"]]);
});
test("将棋の送信失敗は無音、送信後の拒否は抑止を解除し、最終着手と終局を取りこぼさない", () => {
  const state = initialShogiState(),
    room = playingShogiRoom(state);
  const h = renderHook(useFourShogiRoomSession, options(room), wrap());
  const socket = connect(room),
    action = room.legalActions[0]!;
  socket.failSend = true;
  act(() => expect(h.current.handleShogiAction(action)).toBe(false));
  expect(play).not.toHaveBeenCalled();
  socket.failSend = false;
  act(() => expect(h.current.handleShogiAction(action)).toBe(true));
  expect(play.mock.calls.map(([s]) => s)).toEqual([["put"]]);
  socket.receive({ type: "room.error", error: "invalid_move" });
  const next = applyAction(state, "south", action);
  if (!next.ok) throw new Error("fixture");
  socket.snapshot(playingShogiRoom(next.state, 1));
  expect(play.mock.calls.map(([s]) => s)).toEqual([["put"], ["put"]]);
  socket.snapshot(finishedShogiRound().room);
  expect(play.mock.calls.at(-1)).toEqual([["end"]]);
  h.unmount();
  play.mockClear();
  const viewer = renderHook(useFourShogiRoomSession, options(room, true), wrap());
  const other = connect(room, true);
  other.snapshot(finishedShogiRound().room);
  expect(play.mock.calls.map(([s]) => s)).toEqual([["put", "end"]]);
  viewer.unmount();
});
test("切断・GETによる復帰・非表示中の進行は無音、復帰後の新しい着手だけ鳴る", async () => {
  const room = playingRoom();
  if (room.status !== "playing") throw new Error("fixture");
  const h = renderHook(useRoomSession, options(room, true), wrap());
  const socket = connect(room, true);
  act(() => socket.close());
  clock.advance(1000);
  const moved = placeStone(room.game, {
    type: "placeStone",
    position: getLegalMoves(room.game)[0]!,
  });
  if (!moved.ok || moved.state.status !== "playing") throw new Error("fixture");
  const latest = fourReversiRoomSchema.parse({ ...room, game: moved.state });
  requests[0]!.respond({
    room: latest,
    presence: options(room, true).initialPresence,
    serverNowMs: now,
  });
  // 観戦者に資格は保存しません。
  sessionStorage.clear();
  await flush();
  const resumed = connect(latest, true);
  expect(play).not.toHaveBeenCalled();
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    const second = placeStone(moved.state, {
      type: "placeStone",
      position: getLegalMoves(moved.state)[0]!,
    });
    if (!second.ok || second.state.status !== "playing") throw new Error("fixture");
    const hidden = fourReversiRoomSchema.parse({ ...room, game: second.state });
    resumed.snapshot(hidden);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    requests.at(-1)!.respond({
      room: hidden,
      presence: options(room, true).initialPresence,
      serverNowMs: now + 100,
    });
    await flush();
    // 古い通知を複数受けても比較基準を巻き戻しません。
    resumed.snapshot(latest, now + 50);
    resumed.snapshot(hidden);
    expect(play).not.toHaveBeenCalled();
    const third = placeStone(second.state, {
      type: "placeStone",
      position: getLegalMoves(second.state)[0]!,
    });
    if (!third.ok || third.state.status !== "playing") throw new Error("fixture");
    resumed.snapshot(fourReversiRoomSchema.parse({ ...room, game: third.state }), now + 101);
    expect(play.mock.calls.map(([s]) => s)).toEqual([["put"]]);
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
    h.unmount();
  }
});
test("両ゲームのすぐ遊ぶ成功はjoinだけ、作成失敗・既存席の再利用は無音", async () => {
  for (const game of ["four-reversi", "four-shogi"] as const) {
    const h = renderHook(useRoomEntry, game, wrap());
    act(() => {
      h.current.setName("参加者");
    });
    act(() => {
      void h.current.submitRoom("quick");
    });
    requests.at(-1)!.respond({ user: null });
    await flush();
    const room = game === "four-reversi" ? waitingRoom() : waitingShogiRoom();
    requests.at(-1)!.respond({ room, membership: { ...membership, token } }, 201);
    await flush();
    expect(join).toHaveBeenLastCalledWith(room.instanceId, membership.playerId);
    expect(play).not.toHaveBeenCalled();
    h.unmount();
    join.mockClear();
  }
  const h = renderHook(useRoomEntry, "four-reversi", wrap());
  act(() => {
    void h.current.submitRoom("join", "12345");
  });
  requests.at(-1)!.respond({ user: null });
  await flush();
  requests.at(-1)!.respond(membership);
  await flush();
  expect(join).not.toHaveBeenCalled();
  act(() => {
    h.current.setName("参加者");
    void h.current.submitRoom("create");
  });
  requests.at(-1)!.respond({ user: null });
  await flush();
  requests.at(-1)!.respond({ error: "rate_limited" }, 429);
  await flush();
  expect(join).not.toHaveBeenCalled();
});
test("観戦からの参加成功もjoinを要求し、招待の自動表示だけでは要求しない", async () => {
  const room = waitingRoom();
  room.players = room.players.slice(0, 1);
  const h = renderHook(() => useRoomInvitation(room, null, true, () => {}), undefined, wrap());
  expect(join).not.toHaveBeenCalled();
  act(() => {
    h.current.setName("参加者");
  });
  act(() => {
    void h.current.submit();
  });
  requests.at(-1)!.respond({ user: null });
  await flush();
  requests
    .at(-1)!
    .respond({ room, presence: options(room, true).initialPresence, serverNowMs: now });
  await flush();
  requests.at(-1)!.respond({ room, membership: { ...membership, role: "player", token } });
  await flush();
  expect(join).toHaveBeenCalledTimes(1);
  expect(join).toHaveBeenCalledWith(room.instanceId, membership.playerId);
});

test("復帰GETより先に送った本人の手を二重に鳴らさず、遅いGETで新しい通知を巻き戻さない", async () => {
  const room = playingRoom();
  if (room.status !== "playing") throw new Error("fixture");
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const visibility = (value: string) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
  };
  const h = renderHook(useRoomSession, options(room), wrap());
  const socket = connect(room);
  try {
    visibility("hidden");
    visibility("visible");
    const position = getLegalMoves(room.game)[0]!;
    act(() => h.current.handlePlaceStone(position));
    expect(play.mock.calls.map(([s]) => s)).toEqual([["put"]]);
    requests
      .at(-1)!
      .respond({ room, presence: options(room, true).initialPresence, serverNowMs: now + 100 });
    await flush();
    const result = placeStone(room.game, { type: "placeStone", position });
    if (!result.ok || result.state.status !== "playing") throw new Error("fixture");
    const moved = fourReversiRoomSchema.parse({ ...room, game: result.state });
    socket.snapshot(moved, now + 101);
    expect(play).toHaveBeenCalledTimes(1);
    visibility("hidden");
    visibility("visible");
    const other = placeStone(result.state, {
      type: "placeStone",
      position: getLegalMoves(result.state)[0]!,
    });
    if (!other.ok || other.state.status !== "playing") throw new Error("fixture");
    const newer = fourReversiRoomSchema.parse({ ...room, game: other.state });
    socket.snapshot(newer, now + 201);
    requests.at(-1)!.respond({
      room: moved,
      presence: options(room, true).initialPresence,
      serverNowMs: now + 200,
    });
    await flush();
    socket.snapshot(newer, now + 201);
    expect(play).toHaveBeenCalledTimes(1);
    const next = placeStone(other.state, {
      type: "placeStone",
      position: getLegalMoves(other.state)[0]!,
    });
    if (!next.ok || next.state.status !== "playing") throw new Error("fixture");
    socket.snapshot(fourReversiRoomSchema.parse({ ...room, game: next.state }), now + 202);
    expect(play).toHaveBeenCalledTimes(2);
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
    h.unmount();
  }
});
