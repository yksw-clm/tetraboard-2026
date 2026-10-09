import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { gameIds, gameCapacity } from "@tetraboard/protocol/games";
import { roomSchema, isFourShogiRoom, isShogiRoom } from "@tetraboard/protocol";
import { getLegalActions } from "@tetraboard/four-shogi";
import { getActionAvailability } from "@tetraboard/shogi";
import { RoomBoundaryFixtures, boundaryRequest, boundaryJson } from "./roomBoundaryFixtures";
import { ShogiStore } from "../src/rooms/shogiStore";
import { StandardShogiStore } from "../src/rooms/standardShogiStore";

let fixtures = new RoomBoundaryFixtures();
afterEach(async () => {
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});
const requestFor = (game: (typeof gameIds)[number], cpuLevel?: number) => ({
  game,
  name: "ホスト",
  quickPlay: true,
  cpuLevel,
  ...(game === "four-reversi" || game === "four-shogi" ? { mode: "singles" } : {}),
});
for (const game of gameIds) {
  test(`${game}: 作成時のLv1・Lv2と省略時Lv1を全CPUに適用し、不正値を拒否する`, async () => {
    for (const level of [undefined, 1, 2]) {
      const entry = await fixtures.create(requestFor(game, level));
      const cpus = entry.room.players.filter((p) => p.kind === "cpu");
      expect(cpus).toHaveLength(gameCapacity(game) - 1);
      expect(cpus.every((p) => p.level === (level ?? 1) && p.ready)).toBe(true);
      const saved = (await fixtures.snapshot(entry.room.id)).room;
      expect(saved.players).toEqual(entry.room.players);
    }
    for (const cpuLevel of [0, 3, "2", null]) {
      expect(
        (await boundaryRequest("/rooms", boundaryJson({ ...requestFor(game), cpuLevel }))).status,
      ).toBe(400);
    }
  });
  for (const level of [1, 2]) {
    test(`${game} Lv${level}: 1999msでは進まず、休止復帰後の2000ms以降に一手だけ進む`, async () => {
      const entry = await fixtures.create(requestFor(game, level));
      const host = await fixtures.connect(entry);
      host.send({ type: "room.game.start" });
      await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
      const stub = env.GAME_ROOM.getByName(entry.room.id);
      const at = Date.now() + 60_000;
      const before = await runInDurableObject(stub, async (instance, ctx) => {
        let room = roomSchema.parse(ctx.storage.kv.get("room"));
        if (room.status !== "playing") throw Error("Expected playing");
        if (isFourShogiRoom(room)) {
          const cpu = room.players.find((p) => p.kind === "cpu")!;
          const store = new ShogiStore(ctx.storage.sql);
          const full = store.loadState(room.roundId, room.game);
          if (full.status !== "playing") throw Error("Expected playing");
          const next = { ...full, turn: cpu.side };
          room = roomSchema.parse({
            ...room,
            game: store.saveState(room.roundId, next),
            legalActions: getLegalActions(next),
          });
        } else if (isShogiRoom(room)) {
          const cpu = room.players.find((p) => p.kind === "cpu")!;
          const store = new StandardShogiStore(ctx.storage.sql);
          const { state: full } = store.loadTransition(room.roundId, room.game);
          if (full.status !== "playing") throw Error("Expected playing");
          const next = { ...full, turn: cpu.side };
          room = roomSchema.parse({
            ...room,
            game: store.saveState(room.roundId, next),
            ...getActionAvailability(next),
          });
        } else {
          const cpu = room.players.find((p) => p.kind === "cpu")!;
          room = roomSchema.parse({ ...room, game: { ...room.game, turn: cpu.color } });
        }
        if (room.status !== "playing") throw Error("Expected playing");
        room.clock.turnStartedAt = at;
        room.clock.turnExpiresAt = at + 300_000;
        ctx.storage.kv.put("room", room);
        ctx.storage.kv.delete("shogi-cpu-job");
        ctx.storage.kv.delete("standard-shogi-cpu-job");
        const clock = vi.spyOn(Date, "now").mockReturnValue(at + 1_999);
        try {
          await instance.alarm();
          const snapshot = await instance.getRoom();
          expect(snapshot?.game?.moveNumber).toBe(room.game.moveNumber);
          if (snapshot?.status !== "playing") throw Error("Expected playing");
          expect(snapshot.clock.turnStartedAt).toBe(at);
          expect(await ctx.storage.getAlarm()).toBe(at + 2_000);
        } finally {
          clock.mockRestore();
        }
        return room.game.moveNumber;
      });
      await evictDurableObject(stub, { webSockets: "hibernate" });
      await runInDurableObject(stub, async (instance, ctx) => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(at + 2_000);
        try {
          await instance.alarm();
          if (game === "four-shogi" || game === "shogi") {
            const key = game === "shogi" ? "standard-shogi-cpu-job" : "shogi-cpu-job";
            const job = ctx.storage.kv.get<{ applyAt: number }>(key)!;
            expect(job).toBeDefined();
            clock.mockReturnValue(job.applyAt);
            await instance.alarm();
          }
          const moved = roomSchema.parse(ctx.storage.kv.get("room"));
          if (moved.status !== "playing") throw Error("Expected playing");
          expect(moved.game.moveNumber).toBe(before + 1);
          expect(moved.clock.turnStartedAt).toBe(Date.now());
          await instance.alarm();
          expect(roomSchema.parse(ctx.storage.kv.get("room")).game?.moveNumber).toBe(before + 1);
        } finally {
          clock.mockRestore();
        }
      });
    });
  }
}
