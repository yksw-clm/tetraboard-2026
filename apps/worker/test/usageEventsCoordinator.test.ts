import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

test.each([false, true])(
  "serialの外でもbindingへ書き込む（serial実行済み=%s）",
  async (afterSerial) => {
    const stub = env.MATCHMAKING_COORDINATOR.getByName(`usage-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance) => {
      if (afterSerial) await instance.cleanupReleasedGroups();
      const points: AnalyticsEngineDataPoint[] = [];
      const original = Reflect.get(instance, "env");
      Reflect.set(instance, "env", {
        ...original,
        USAGE_EVENTS: {
          writeDataPoint(point: AnalyticsEngineDataPoint) {
            points.push(point);
          },
        },
      });
      try {
        Reflect.get(instance, "event").call(
          instance,
          { operationId: "operation", accountId: "account", joinedAtMs: Date.now(), isTest: false },
          "accepted",
        );
        expect(points).toEqual([
          {
            indexes: ["matchmaking"],
            blobs: [
              "matchmaking",
              "0",
              "four-reversi",
              "",
              "account",
              "operation",
              "accepted",
              "",
              "1",
            ],
            doubles: [0, 0],
          },
        ]);
      } finally {
        Reflect.set(instance, "env", original);
      }
    });
  },
);
