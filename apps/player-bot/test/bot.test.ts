import { test, expect } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roomSocketContract, createRoomContract, joinRoomContract } from "@tetraboard/protocol";
import { GameFixture, ids, token } from "./fixtures";
import { Store } from "../src/store";
import { runConfigSchema, origin } from "../src/config";
import { runBots } from "../src/bot";
import { StopControl } from "../src/session";
import { sendAt, deadline, turnFor } from "../src/game";
import type { ServerWebSocket } from "bun";

test("期限はサーバー時刻と受信時刻で計算し、短い時計では5秒未満へ短縮する", () => {
  const f = new GameFixture("four-reversi");
  ids.forEach((_, i) => f.members.add(i));
  f.start();
  const room = f.room();
  if (room.status !== "playing") throw Error("fixture");
  room.clock.turnExpiresAt = 110000;
  const turn = turnFor(
    {
      type: "room.snapshot",
      room,
      serverNowMs: 100000,
      presence: { hostPlayerId: ids[0], connectedPlayerIds: ids },
    },
    ids[0],
    100,
  )!;
  expect(deadline(turn)).toBe(9100);
  expect(sendAt(turn, () => 0)).toBe(5100);
  expect(sendAt(turn, () => 0.99999)).toBe(9100);
  room.clock.turnExpiresAt = 102000;
  expect(sendAt(turn, () => 0)).toBe(1100);
  expect(
    turnFor(
      {
        type: "room.snapshot",
        room,
        serverNowMs: 100000,
        presence: { hostPlayerId: ids[0], connectedPlayerIds: ids },
      },
      ids[1],
      100,
    ),
  ).toBeNull();
});

test("接続先とプロフィールの範囲を検証する", () => {
  expect(origin("https://tetraboard.net")).toBe("https://tetraboard.net");
  for (const url of [
    "http://example.com",
    "https://a:b@example.com",
    "https://example.com/rooms/12345",
  ])
    expect(() => origin(url)).toThrow();
  expect(() =>
    runConfigSchema.parse({
      origin: "https://tetraboard.net",
      game: "four-shogi",
      profiles: ["bot", "bot"],
      target: { type: "rated" },
    }),
  ).toThrow();
});

for (const game of ["four-reversi", "four-shogi"] as const) {
  test(`${game}: 4BOTが実HTTP/WSで作成・準備・完局・再戦し、AI障害でも合法手で継続する`, async () => {
    const home = await mkdtemp(join(tmpdir(), "tb37-bot-"));
    const f = new GameFixture(game);
    const stop = new StopControl();
    const sockets = new Set<ServerWebSocket<{ i: number | null }>>();
    const events: string[] = [];
    const errors: unknown[] = [];
    let forcedLeaves = 0;
    const frame = () => ({
      type: "room.snapshot",
      room: f.room(),
      serverNowMs: Date.now(),
      presence: {
        hostPlayerId: ids[0],
        connectedPlayerIds: [...sockets].flatMap((s) => (s.data.i === null ? [] : [ids[s.data.i]])),
      },
    });
    const broadcast = () => {
      const message = JSON.stringify(frame());
      for (const socket of sockets) socket.send(message);
    };
    const server = Bun.serve<{ i: number | null }>({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, server) {
        try {
          const url = new URL(request.url),
            p = url.pathname;
          if (p.endsWith("/ws")) {
            expect(request.headers.get("Origin")).toBe(url.origin);
            if (server.upgrade(request, { data: { i: null } })) return;
          }
          const i = Number(request.headers.get("Cookie")?.match(/test([1-4])/)?.[1] ?? 1) - 1;
          if (p === "/api/account/session")
            return Response.json({
              user: {
                name: `BOT-${i + 1}`,
                username: `bot${i + 1}`,
                profileId: ids[i],
                avatarUrl: null,
                profileCompleted: true,
                isGuest: false,
              },
            });
          if (p === "/api/account/legal")
            return Response.json({ accepted: true, version: "2026-11-11" });
          const membership = {
            playerId: ids[i],
            role: i === 0 ? "host" : "player",
            token: token(i),
          };
          if (request.method === "POST" && (p === "/api/rooms" || p.endsWith("/players"))) {
            expect(request.headers.get("X-Legal-Consent")).toBe("2026-11-11");
            if (p === "/api/rooms") createRoomContract.request.parse(await request.json());
            else joinRoomContract.request.parse(await request.json());
            f.members.add(i);
            return Response.json({ room: f.room(), membership });
          }
          if (p.endsWith("/me"))
            return Response.json({ playerId: membership.playerId, role: membership.role });
          if (p.endsWith("/leave")) {
            if (f.playing) forcedLeaves++;
            f.members.delete(i);
            return new Response(null, { status: 204 });
          }
          if (p === "/api/rooms/12345") {
            const { type: _type, ...value } = frame();
            return Response.json(value);
          }
          return new Response(null, { status: 404 });
        } catch (error) {
          errors.push(error);
          return new Response(null, { status: 500 });
        }
      },
      websocket: {
        open(socket) {
          sockets.add(socket);
          socket.send(JSON.stringify(frame()));
        },
        message(socket, message) {
          try {
            const m = roomSocketContract.clientMessage.parse(JSON.parse(String(message)));
            if (m.type === "room.auth") {
              const i = ids.findIndex((_, i) => token(i) === m.token);
              expect(i).toBeGreaterThanOrEqual(0);
              socket.data.i = i;
              broadcast();
              socket.send(
                JSON.stringify({
                  type: "room.authenticated",
                  membership: { playerId: ids[i], role: i === 0 ? "host" : "player" },
                }),
              );
            } else {
              const i = socket.data.i!;
              if (m.type === "room.ready.set") {
                f.ready.add(i);
                broadcast();
              }
              if (m.type === "room.game.start") {
                expect(i).toBe(0);
                expect(f.ready.size).toBe(4);
                f.start();
                broadcast();
              }
              if (m.type === "room.game.action") {
                expect(["placeStone", "movePiece", "dropPiece"]).toContain(m.action.type);
                f.action(i, m.action as Parameters<GameFixture["action"]>[1]);
                if (f.rounds === 2) stop.request();
                broadcast();
              }
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
    const watchdog = setTimeout(() => {
      stop.mode = "force";
    }, 10000);
    try {
      const url = server.url.origin;
      for (let i = 0; i < 4; i++)
        await new Store(url, `bot${i + 1}`, home).saveProfile({
          cookie: `test${i + 1}`,
          identity: ids[i],
        });
      await runBots(
        runConfigSchema.parse({
          origin: url,
          game,
          profiles: ["bot1", "bot2", "bot3", "bot4"],
          target: { type: "create" },
        }),
        stop,
        {
          home,
          analysis: () => ({
            watch: async () => {
              throw Error("offline");
            },
            close: async () => {},
          }),
          delay: (turn) => turn.receivedAt,
          pause: () => Bun.sleep(0),
          log: () => (event) => events.push(event),
        },
      );
      expect(errors).toEqual([]);
      expect(f.rounds).toBe(2);
      expect(f.moves).toBeGreaterThan(20);
      expect(events.filter((e) => e === "game_end")).toHaveLength(8);
      expect(events).toContain("fallback");
      expect(forcedLeaves).toBe(0);
      for (let i = 0; i < 4; i++) {
        const store = new Store(url, `bot${i + 1}`, home);
        expect((await store.loadState())?.seat).toBeUndefined();
        expect((await stat(join(store.directory, "profile.json"))).mode & 0o777).toBe(0o600);
      }
    } finally {
      clearTimeout(watchdog);
      stop.mode = "force";
      await server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  }, 15000);
}
