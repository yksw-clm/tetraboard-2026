import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { isFourShogiRoom } from "@tetraboard/protocol";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";
import { startCpuRoom } from "./cpuAdapterFixtures";
import { externalCpuEnvironment, prepareExternalCpuRoom } from "./cpuExternalFixtures";
import type { PlayingFor } from "../src/rooms/gameProgress";
import type { GameId } from "@tetraboard/protocol";

let fixtures = new RoomBoundaryFixtures();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});

const paths = [
  { game: "four-reversi", key: "four-reversi-ai-job", cpuKey: "four-reversi-cpu-job" },
  { game: "four-shogi", key: "four-shogi-ai-job", cpuKey: "shogi-cpu-job" },
  { game: "shogi", key: "standard-shogi-external-cpu-job", cpuKey: "standard-shogi-cpu-job" },
  { game: "reversi", key: "reversi-external-cpu-job", cpuKey: null },
] as const;

test.each(paths.flatMap((path) => [true, false].map((fallback) => ({ ...path, fallback }))))(
  "$game: AI 待ちの期限と応答を保存し、次の Alarm で一度だけ適用する（予備手=$fallback）",
  async ({ game, key, cpuKey, fallback }) => {
    const { stub, at, room } = await startCpuRoom(fixtures, game, 2);
    await runInDurableObject(stub, async (instance, ctx) => {
      prepareExternalCpuRoom(ctx, room, at);
      const observed = externalCpuEnvironment(instance, ctx, room, { game, key, at, fallback });
      const { clock, gateway } = observed;
      try {
        await instance.alarm();
        expect(gateway).toHaveBeenCalledTimes(1);
        expect((await instance.getRoom())?.game?.moveNumber).toBe(room.game.moveNumber);
        if (cpuKey) {
          expect(ctx.storage.kv.get<{ applyAt: number }>(cpuKey)?.applyAt).toBe(at + 2001);
          expect(await ctx.storage.getAlarm()).toBe(at + 2001);
          if (game === "four-reversi")
            expect(ctx.storage.kv.get<{ source: string }>(cpuKey)?.source).toBe(
              fallback ? "fallback" : "external",
            );
          if (game === "shogi")
            expect(ctx.storage.kv.get<{ external?: true }>(cpuKey)?.external).toBe(
              fallback ? undefined : true,
            );
        } else expect(await ctx.storage.getAlarm()).toBe(at + 2000);
        clock.mockReturnValue(at + 2001);
        await instance.alarm();
        await instance.alarm();
        expect((await instance.getRoom())?.game?.moveNumber).toBe(room.game.moveNumber + 1);
        expect(gateway).toHaveBeenCalledTimes(1);
        expectDiagnostics(observed, game, room, fallback);
      } finally {
        await observed.restore();
      }
    });
  },
);

function expectDiagnostics(
  logs: Pick<Console, "info" | "warn">,
  game: GameId,
  room: PlayingFor<GameId>,
  fallback: boolean,
) {
  if (game === "four-reversi" && fallback)
    expect(logs.warn).toHaveBeenCalledWith("AI service fallback", { reason: "http_401" });
  if (game === "reversi")
    expect(logs.info).toHaveBeenCalledWith("Reversi AI response", {
      source: fallback ? "fallback" : "engine",
      elapsedMs: expect.any(Number),
    });
  if (isFourShogiRoom(room) && fallback)
    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "four_shogi_ai_fallback_applied",
        game,
        matchId: room.roundId,
        reason: "http_401",
        requestId: expect.any(String),
      }),
    );
}
