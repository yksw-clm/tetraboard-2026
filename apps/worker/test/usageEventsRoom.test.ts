import type { Room } from "@tetraboard/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { endAnalyticsMatch, startAnalyticsMatch } from "../src/adapters/room/usage";
import { recordUsageEvents } from "./usageEventsRecorder";

test("人間の参加者が0人なら開始と終了のisTestはfalseになる", async () => {
  const events = recordUsageEvents();
  const matchId = crypto.randomUUID();
  const stub = env.GAME_ROOM.getByName(`usage-${crypto.randomUUID()}`);
  await runInDurableObject(stub, (instance) => {
    const at = Date.now();
    startAnalyticsMatch(
      Reflect.get(instance, "runtime"),
      matchId,
      { settings: { game: "four-reversi", mode: "singles" }, players: [] } as unknown as Room,
      at,
    );
    endAnalyticsMatch(Reflect.get(instance, "runtime"), "abandoned", at + 1000);
  });
  expect(events.filter((e) => "matchId" in e && e.matchId === matchId)).toEqual([
    {
      name: "match_started",
      game: "four-reversi",
      matchId,
      isTest: false,
      mode: "singles",
      matchKind: "normal",
      humans: 0,
      cpus: 0,
    },
    {
      name: "match_ended",
      game: "four-reversi",
      matchId,
      isTest: false,
      result: "abandoned",
      reason: "abandoned",
      durationMs: 1000,
    },
  ]);
});
