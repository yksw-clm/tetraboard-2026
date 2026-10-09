import { afterEach, beforeEach, expect, test } from "bun:test";
import { useSessionChat } from "../src/features/room/useSessionChat";
import type { FormEvent } from "react";
import { useRoomSession } from "../src/features/room/useRoomSession";
import { useFourShogiRoomSession } from "../src/features/room/useFourShogiRoomSession";
import { saveRoomMembershipToken, readRoomMembershipToken } from "../src/shared/roomMembership";
import { membership, now, playerIds, token, waitingRoom } from "../test/fixtures/rooms";
import { playingShogiRoom, waitingShogiRoom } from "../test/fixtures/fourShogiFixtures";
import { act, clock, flush, renderHook, requests, wrap } from "./harness";
import { installSocket, Socket } from "./socket";
import { roomSchema, type Room } from "@tetraboard/protocol";

let restoreSocket: () => void;
beforeEach(() => {
  restoreSocket = installSocket();
});
afterEach(() => restoreSocket());
function options<T extends Room>(room: T) {
  saveRoomMembershipToken(room.id, token);
  return {
    initialRoom: room,
    initialMembership: membership,
    initialServerNowMs: now,
    initialPresence: { hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds },
  };
}
function connect(room: Room) {
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.snapshot(room, now + clock.now);
  socket.receive({ type: "room.authenticated", membership });
  return socket;
}
function snapshot(room: Room, serverNowMs = now) {
  return {
    room,
    presence: { hostPlayerId: playerIds[0]!, connectedPlayerIds: playerIds },
    serverNowMs,
  };
}
async function restore(room: Room) {
  requests.at(-1)!.respond(snapshot(room, now + clock.now));
  await flush();
  requests.at(-1)!.respond(membership);
  await flush();
  return connect(room);
}
for (const game of ["four-reversi", "four-shogi"] as const) {
  function mount() {
    if (game === "four-reversi") {
      const room = waitingRoom();
      return { room, hook: renderHook(useRoomSession, options(room), wrap()) };
    }
    const room = waitingShogiRoom();
    return { room, hook: renderHook(useFourShogiRoomSession, options(room), wrap()) };
  }
  test(`${game}: pagehideは接続と待ちを止め、pageshowで確定状態と本人資格を復元する`, async () => {
    const { room, hook } = mount();
    const socket = connect(room);
    socket.deferClose = true;
    act(() => hook.current.handleReadyClick());
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(socket.readyState).toBe(2);
    expect(hook.current.authenticated).toBe(false);
    expect(hook.current.pendingReady).toBeNull();
    expect(readRoomMembershipToken(room.id)).toBe(token);
    clock.advance(60000);
    expect(requests).toHaveLength(0);
    act(() => socket.finishClose());
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(requests).toHaveLength(1);
    const updated = roomSchema.parse({
      ...room,
      players: room.players.map((p, i) => (i === 0 ? { ...p, ready: true } : p)),
    });
    await restore(updated);
    expect(hook.current.self?.ready).toBe(true);
    expect(hook.current.authenticated).toBe(true);
    expect(Socket.instances).toHaveLength(2);
    expect(Socket.instances[1]!.sent).toEqual([{ type: "room.auth", token }]);
  });
  test(`${game}: 無関係な通知で期限を延ばさず、10秒で準備待ちを復旧し自動再送しない`, async () => {
    const { room, hook } = mount();
    const socket = connect(room);
    socket.deferClose = true;
    act(() => hook.current.handleReadyClick());
    clock.advance(9999);
    socket.snapshot(room);
    expect(hook.current.pendingReady).toBe(true);
    clock.advance(1);
    expect(hook.current.pendingReady).toBeNull();
    expect(hook.current.authenticated).toBe(false);
    expect(hook.current.connection).toBe("再接続中");
    clock.advance(1000);
    const resumed = await restore(room);
    act(() => socket.finishClose());
    expect(hook.current.authenticated).toBe(true);
    clock.advance(1000);
    expect(requests).toHaveLength(2);
    expect(resumed.sent).toEqual([{ type: "room.auth", token }]);
    act(() => hook.current.handleReadyClick());
    expect(resumed.sent.at(-1)).toEqual({ type: "room.ready.set", ready: true });
  });
}

test("復旧GETが応答しなくても再試行し、古い完了と離脱後の完了は捨てる", async () => {
  const room = waitingRoom();
  const hook = renderHook(useRoomSession, options(room), wrap());
  act(() => connect(room).close());
  clock.advance(1000);
  const oldRequest = requests[0]!;
  clock.advance(10000);
  expect(oldRequest.init.signal?.aborted).toBe(true);
  clock.advance(2000);
  expect(requests).toHaveLength(2);
  oldRequest.respond(snapshot(room));
  await flush();
  expect(requests).toHaveLength(2);
  expect(Socket.instances).toHaveLength(1);
  act(() => window.dispatchEvent(new Event("pagehide")));
  requests[1]!.respond(snapshot(room));
  await flush();
  clock.advance(60000);
  expect(Socket.instances).toHaveLength(1);
  expect(hook.current.authenticated).toBe(false);
});

test("OPENでもsnapshot・認証が揃わなければ10秒で再接続する", () => {
  const room = waitingRoom();
  const hook = renderHook(useRoomSession, options(room), wrap());
  const socket = Socket.instances[0]!;
  socket.open();
  socket.snapshot(room);
  clock.advance(9999);
  expect(hook.current.authenticated).toBe(false);
  clock.advance(1);
  expect(socket.readyState).toBe(3);
  expect(hook.current.connection).toBe("再接続中");
  clock.advance(1000);
  expect(requests).toHaveLength(1);
});

test.each([100, 200])(
  "非表示復帰の遅いGET（時刻差%s）は新しい通知を巻き戻さない",
  async (offset) => {
    const room = waitingRoom();
    const hook = renderHook(useRoomSession, options(room), wrap());
    const socket = connect(room);
    const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const visibility = (value: string) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
    };
    try {
      visibility("hidden");
      expect(socket.readyState).toBe(1);
      visibility("visible");
      expect(hook.current.authenticated).toBe(false);
      const newer = { ...room, settings: { ...room.settings, mode: "doubles" as const } };
      socket.snapshot(newer, now + 200);
      requests[0]!.respond(snapshot(room, now + offset));
      await flush();
      requests[1]!.respond(membership);
      await flush();
      socket.receive({ type: "room.authenticated", membership });
      expect(hook.current.room.settings.mode).toBe("doubles");
      expect(hook.current.authenticated).toBe(true);
      expect(Socket.instances).toHaveLength(1);
    } finally {
      if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  },
);

for (const operation of ["settings", "start", "move"] as const) {
  test(`${operation}: 応答停止は10秒で待ちと未確定表示を解除する`, () => {
    const room = operation === "move" ? playingShogiRoom() : waitingShogiRoom();
    room.players.forEach((p) => {
      p.ready = true;
    });
    const hook = renderHook(useFourShogiRoomSession, options(room), wrap());
    const socket = connect(room);
    act(() => {
      if (operation === "settings") hook.current.changeMode("doubles");
      else if (operation === "start") hook.current.handleStartClick();
      else if (room.status === "playing") hook.current.handleShogiAction(room.legalActions[0]!);
    });
    clock.advance(9999);
    socket.snapshot(room, now + clock.now);
    expect(
      operation === "settings"
        ? hook.current.pendingSettingsCommand
        : hook.current.pendingGameAction,
    ).not.toBeNull();
    clock.advance(1);
    expect(hook.current.pendingSettingsCommand).toBeNull();
    expect(hook.current.pendingGameAction).toBeNull();
    expect(hook.current.pendingMove).toBeNull();
    expect(hook.current.moveNotice).toBeNull();
    if (room.status === "playing") expect(hook.current.displayGame).toEqual(room.game);
    expect(socket.readyState).toBe(3);
    expect(hook.current.connection).toBe("再接続中");
  });
}

test("期限前の操作完了はタイマーを取り消し、次の操作に時間を持ち越さない", () => {
  const room = waitingRoom();
  const hook = renderHook(useRoomSession, options(room), wrap());
  const socket = connect(room);
  act(() => hook.current.handleReadyClick());
  clock.advance(9999);
  const updated = roomSchema.parse({
    ...room,
    players: room.players.map((p, i) => (i === 0 ? { ...p, ready: true } : p)),
  });
  socket.snapshot(updated, now + clock.now);
  expect(hook.current.pendingReady).toBeNull();
  clock.advance(10001);
  expect(hook.current.connection).toBe("接続済み");
  act(() => hook.current.handleReadyClick());
  clock.advance(9999);
  expect(hook.current.pendingReady).toBe(false);
  clock.advance(1);
  expect(hook.current.pendingReady).toBeNull();
  expect(hook.current.connection).toBe("再接続中");
});

for (const accepted of [true, false]) {
  test(`チャットの${accepted ? "反映" : "応答停止"}で送信待ちを解除し、未反映の入力を残す`, () => {
    const room = waitingRoom();
    const hook = renderHook(
      (input: ReturnType<typeof options<typeof room>>) => {
        const session = useRoomSession(input);
        return { session, chat: useSessionChat(session) };
      },
      options(room),
      wrap(),
    );
    const socket = connect(room);
    socket.receive({ type: "room.chat.snapshot", messages: [] });
    act(() => hook.current.chat.setInput("こんにちは"));
    act(() =>
      hook.current.chat.handleSubmit({ preventDefault() {} } as FormEvent<HTMLFormElement>),
    );
    expect(hook.current.chat.pending).toBe(true);
    clock.advance(9999);
    if (accepted)
      socket.receive({
        type: "room.chat.snapshot",
        messages: [
          {
            id: crypto.randomUUID(),
            kind: "player",
            senderId: membership.playerId,
            senderName: "本人",
            text: "こんにちは",
            sentAtMs: now + clock.now,
          },
        ],
      });
    else socket.receive({ type: "room.chat.snapshot", messages: [] });
    clock.advance(1);
    expect(hook.current.chat.pending).toBe(false);
    expect(hook.current.chat.input).toBe(accepted ? "" : "こんにちは");
    expect(hook.current.session.connection).toBe(accepted ? "接続済み" : "再接続中");
  });
}

test("復帰GETの閉鎖・世代変更は再試行を止める", async () => {
  for (const status of [404, 410]) {
    const room = waitingRoom();
    const hook = renderHook(useRoomSession, options(room), wrap());
    connect(room);
    act(() => window.dispatchEvent(new Event("pagehide")));
    act(() => window.dispatchEvent(new Event("pageshow")));
    requests.at(-1)!.respond({ error: "not_found" }, status);
    await flush();
    expect(hook.current.unavailable).toContain("閉鎖");
    const requestCount = requests.length;
    clock.advance(60000);
    expect(requests).toHaveLength(requestCount);
    hook.unmount();
  }
});

test("本人確認の応答停止も10秒で中止し、初期pageshowとunmount後には接続を増やさない", async () => {
  const room = waitingRoom();
  const hook = renderHook(useRoomSession, options(room), wrap());
  const socket = connect(room);
  act(() => window.dispatchEvent(new Event("pageshow")));
  expect(requests).toHaveLength(0);
  act(() => socket.close());
  clock.advance(1000);
  requests[0]!.respond(snapshot(room, now + clock.now));
  await flush();
  expect(requests[1]!.url).toContain("/me");
  clock.advance(10000);
  expect(requests[1]!.init.signal?.aborted).toBe(true);
  hook.unmount();
  requests[1]!.respond(membership);
  await flush();
  clock.advance(60000);
  act(() => window.dispatchEvent(new Event("pageshow")));
  expect(Socket.instances).toHaveLength(1);
  expect(requests).toHaveLength(2);
});

test("離脱後に届いた本人確認401で保存した参加資格を消さない", async () => {
  const room = waitingRoom();
  const hook = renderHook(useRoomSession, options(room), wrap());
  act(() => connect(room).close());
  clock.advance(1000);
  requests[0]!.respond(snapshot(room, now + clock.now));
  await flush();
  const pendingMembership = requests[1]!;
  act(() => window.dispatchEvent(new Event("pagehide")));
  pendingMembership.respond({ error: "unauthorized" }, 401);
  await flush();
  expect(readRoomMembershipToken(room.id)).toBe(token);
  expect(hook.current.membership).toEqual(membership);
  expect(hook.current.authenticated).toBe(false);
});

test("非表示中にタイマーが停止しても復帰時に過ぎた操作期限を検出する", () => {
  const room = waitingRoom();
  const hook = renderHook(useRoomSession, options(room), wrap());
  const socket = connect(room);
  act(() => hook.current.handleReadyClick());
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    clock.now += 10000;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(hook.current.pendingReady).toBeNull();
    expect(hook.current.authenticated).toBe(false);
    expect(socket.readyState).toBe(3);
    expect(hook.current.connection).toBe("再接続中");
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});
