import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { recordUsageEvents } from "./usageEventsRecorder";

test("人間の参加者が0人なら開始と終了のisTestはfalseになる", async () => {
  const events = recordUsageEvents();
  const stub = env.GAME_ROOM.getByName(`usage-${crypto.randomUUID()}`);
  await runInDurableObject(stub, (instance) => {
    const at = Date.now();
    Reflect.get(instance, "startAnalyticsMatch").call(
      instance,
      "match",
      { settings: { game: "four-reversi", mode: "singles" }, players: [] },
      at,
    );
    Reflect.get(instance, "endAnalyticsMatch").call(instance, "abandoned", at + 1000);
  });
  expect(events).toEqual([
    {
      name: "match_started",
      game: "four-reversi",
      matchId: "match",
      isTest: false,
      mode: "singles",
      matchKind: "normal",
      humans: 0,
      cpus: 0,
    },
    {
      name: "match_ended",
      game: "four-reversi",
      matchId: "match",
      isTest: false,
      result: "abandoned",
      reason: "abandoned",
      durationMs: 1000,
    },
  ]);
});
