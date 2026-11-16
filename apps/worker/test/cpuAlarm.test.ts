import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { gameIds } from "@tetraboard/protocol/games";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";
import { startCpuRoom } from "./cpuAdapterFixtures";

let fixtures = new RoomBoundaryFixtures();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});

test.each(gameIds)("%s: CPU の最初の Alarm は手番開始から 2 秒後", async (game) => {
  const { stub, at } = await startCpuRoom(fixtures, game);
  await runInDurableObject(stub, async (instance, ctx) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      await instance.getRoom();
      expect(await ctx.storage.getAlarm()).toBe(at + 2000);
    } finally {
      clock.mockRestore();
    }
  });
});

const savedJobs = [
  { game: "four-reversi", key: "four-reversi-cpu-job" },
  { game: "four-shogi", key: "shogi-cpu-job" },
  { game: "shogi", key: "standard-shogi-cpu-job" },
  { game: "four-gomoku", key: "four-gomoku-cpu-job" },
  { game: "gomoku", key: "gomoku-cpu-job" },
] as const;
for (const applyOffset of [1000, 5000]) {
  test.each(savedJobs)(
    `$game: 保存した手の Alarm は applyAt と 2 秒後の遅い方（applyAt=${applyOffset}ms）`,
    async ({ game, key }) => {
      const { stub, at, room } = await startCpuRoom(fixtures, game);
      await runInDurableObject(stub, async (instance, ctx) => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(at + 2000);
        try {
          await instance.alarm();
          const job = ctx.storage.kv.get<{ applyAt: number }>(key);
          expect(job).toBeDefined();
          ctx.storage.kv.put(key, { ...job, applyAt: at + applyOffset });
          await instance.getRoom();
          expect(await ctx.storage.getAlarm()).toBe(at + Math.max(2000, applyOffset));
          expect((await instance.getRoom())?.game?.moveNumber).toBe(room.game.moveNumber);
        } finally {
          clock.mockRestore();
        }
      });
    },
  );
}
