import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { gameIds, type GameId, type Room } from "@tetraboard/protocol";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
afterEach(async () => {
  await fixtures.dispose();
});

async function setup(game: GameId, status: Room["status"]) {
  const entry = await fixtures.create({
    game,
    name: "本人",
    quickPlay: true,
    ...(game.startsWith("four-") ? { mode: "singles" } : {}),
  });
  const host = await fixtures.connect(entry);
  if (status === "waiting") return (await fixtures.snapshot(entry.room.id)).room;
  host.send({ type: "room.game.start" });
  return (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room;
}

const readers = ["getRoom", "getShareMetadata"] as const;
for (const reader of readers) {
  for (const status of ["waiting", "playing"] as const) {
    test.each(gameIds)(
      `${reader}: %s の ${status} 状態では移行用の棋譜を読まない`,
      async (game) => {
        const room = await setup(game, status);
        const stub = env.GAME_ROOM.getByName(room.id);
        await runInDurableObject(stub, async (instance, state) => {
          // 大きな棋譜の読み取りが増えないことを、実際のKV境界で数えます。
          const get = vi.spyOn(state.storage.kv, "get");
          try {
            const result =
              reader === "getRoom"
                ? await instance.getRoom()
                : await instance.getShareMetadata(room.instanceId);
            expect(result).toMatchObject({ id: room.id, instanceId: room.instanceId });
            expect(get.mock.calls.filter(([key]) => key === "round-replay")).toHaveLength(0);
          } finally {
            get.mockRestore();
          }
        });
      },
    );
  }

  test.each(["roundId", "positionRevision", "both", "waiting"] as const)(
    `${reader}: 通常リバーシの欠落欄 %s の補完に必要な場合だけ棋譜を読む`,
    async (missing) => {
      const room = await setup("reversi", missing === "waiting" ? "waiting" : "playing");
      const stub = env.GAME_ROOM.getByName(room.id);
      await runInDurableObject(stub, async (instance, state) => {
        const original = state.storage.kv.get<Record<string, unknown>>("room")!;
        const saved = { ...original };
        if (missing !== "positionRevision") delete saved.roundId;
        if (missing !== "roundId") delete saved.positionRevision;
        state.storage.kv.put("room", saved);
        const get = vi.spyOn(state.storage.kv, "get");
        try {
          const result =
            reader === "getRoom"
              ? await instance.getRoom()
              : await instance.getShareMetadata(room.instanceId);
          expect(result).toMatchObject(
            reader === "getRoom"
              ? {
                  id: room.id,
                  instanceId: room.instanceId,
                  roundId: "roundId" in room ? room.roundId : null,
                  positionRevision: 0,
                  game: room.game,
                }
              : { id: room.id, instanceId: room.instanceId, settings: { game: "reversi" } },
          );
          const reads = get.mock.calls.filter(([key]) => key === "round-replay").length;
          if (missing === "roundId" || missing === "both") expect(reads).toBeGreaterThan(0);
          else expect(reads).toBe(0);
          expect(state.storage.kv.get("room")).toEqual(saved);
        } finally {
          get.mockRestore();
          state.storage.kv.put("room", original);
        }
      });
    },
  );
}
