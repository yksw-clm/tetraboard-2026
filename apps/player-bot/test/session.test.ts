import { test, expect } from "bun:test";
import { eliminateColor } from "@tetraboard/four-reversi";
import { roomSocketContract, type RoomSocketClientMessage } from "@tetraboard/protocol";
import type { ServerWebSocket } from "bun";
import { GameFixture, ids, token, instanceId } from "./fixtures";
import { Api } from "../src/api";
import { RoomSession, StopControl } from "../src/session";
import type { Analysis } from "../src/ai";

function rig(
  hooks: { auth?: (count: number) => void; action?: () => void; watch: Analysis["watch"] },
  playing = true,
) {
  const f = new GameFixture("four-reversi");
  ids.forEach((_, i) => {
    f.members.add(i);
    f.ready.add(i);
  });
  if (playing) f.start();
  const stop = new StopControl();
  const sockets = new Set<ServerWebSocket<unknown>>();
  const commands: RoomSocketClientMessage[] = [];
  const errors: unknown[] = [];
  let auths = 0;
  const frame = () => ({
    type: "room.snapshot",
    room: f.room(),
    presence: { hostPlayerId: ids[0], connectedPlayerIds: ids },
    serverNowMs: Date.now(),
  });
  const broadcast = () => {
    const value = JSON.stringify(frame());
    for (const socket of sockets) socket.send(value);
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/ws") && server.upgrade(request)) return;
      if (url.pathname.endsWith("/me")) return Response.json({ playerId: ids[0], role: "host" });
      const { type: _type, ...value } = frame();
      return Response.json(value);
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
      },
      message(socket, data) {
        try {
          const command = roomSocketContract.clientMessage.parse(JSON.parse(String(data)));
          commands.push(command);
          if (command.type === "room.auth") {
            expect(command.token).toBe(token(0));
            broadcast();
            socket.send(
              JSON.stringify({
                type: "room.authenticated",
                membership: { playerId: ids[0], role: "host" },
              }),
            );
            hooks.auth?.(++auths);
          } else if (command.type === "room.ready.set") {
            if (command.ready) f.ready.add(0);
            else f.ready.delete(0);
            broadcast();
          } else if (command.type === "room.game.action") {
            f.action(0, command.action as Parameters<GameFixture["action"]>[1]);
            hooks.action?.();
          }
        } catch (error) {
          errors.push(error);
          stop.mode = "force";
        }
      },
      close(socket) {
        sockets.delete(socket);
      },
    },
  });
  const api = new Api(server.url.origin, { cookie: "test", identity: ids[0] }, async () => {});
  const session = new RoomSession(
    api,
    { roomId: "12345", instanceId, token: token(0), playerId: ids[0] },
    "four-reversi",
    { watch: hooks.watch, close: async () => {} },
    stop,
    () => stop.mode !== "running",
    () => {},
    () => performance.now() + 10,
    () => Bun.sleep(0),
  );
  return { f, stop, server, session, sockets, commands, errors, broadcast };
}

test("成立済み・開始前の通常停止は、準備や開始コマンドを送らず現局を完走する", async () => {
  const h = rig(
    {
      auth() {
        h.f.start();
        h.broadcast();
      },
      action() {
        for (const color of ["white", "red", "blue"] as const) {
          const result = eliminateColor(h.f.rev, color);
          if (!result.ok) throw Error(result.reason);
          h.f.rev = result.state;
        }
        h.f.playing = false;
        h.f.rounds = 1;
        h.f.ready.clear();
        h.broadcast();
      },
      async watch(turn, _api, _signal, candidate) {
        candidate(turn.actions[0]);
      },
    },
    false,
  );
  h.stop.request();
  try {
    expect(await h.session.play(true)).toBe("finished");
    expect(h.errors).toEqual([]);
    expect(h.commands.map((c) => c.type)).toEqual(["room.auth", "room.game.action"]);
  } finally {
    h.stop.mode = "force";
    await h.server.stop(true);
  }
});

test("再接続では最新局面を確認し、切断前のAI候補を着手に使わない", async () => {
  let late: (() => void) | undefined;
  let oldSignal: AbortSignal | undefined;
  const h = rig({
    auth(count) {
      if (count === 2) {
        late?.();
        h.stop.mode = "force";
      }
    },
    async watch(turn, _api, signal, candidate) {
      oldSignal = signal;
      late = () => candidate(turn.actions[0]);
      h.f.action(0, turn.actions[0] as Parameters<GameFixture["action"]>[1]);
      for (const socket of h.sockets) socket.terminate();
    },
  });
  try {
    expect(await h.session.play(true)).toBe("stopped");
    expect(h.errors).toEqual([]);
    expect(oldSignal?.aborted).toBe(true);
    expect(h.commands.filter((c) => c.type === "room.auth")).toHaveLength(2);
    expect(h.commands.filter((c) => c.type === "room.game.action")).toHaveLength(0);
  } finally {
    h.stop.mode = "force";
    await h.server.stop(true);
  }
});

test("通常ルームの待機中に停止した場合は準備解除を確認してから退出する", async () => {
  const h = rig(
    {
      async watch() {
        throw Error("must not analyze");
      },
    },
    false,
  );
  h.stop.request();
  try {
    expect(await h.session.play(false)).toBe("stopped");
    expect(h.errors).toEqual([]);
    expect(h.commands.map((c) => c.type)).toEqual(["room.auth", "room.ready.set"]);
    expect(h.commands.at(-1)).toEqual({ type: "room.ready.set", ready: false });
    expect(h.f.ready.has(0)).toBe(false);
  } finally {
    h.stop.mode = "force";
    await h.server.stop(true);
  }
});
