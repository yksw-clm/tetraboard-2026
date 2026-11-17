import { setTimeout as delay } from "node:timers/promises";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import type { RoomRuntime } from "../src/durableObjects/gameRoom/runtime";
import { disposeDurableObjects } from "./durableObjectCleanup";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

async function expectCleanupTimeout(
  stub: DurableObjectStub,
  waiting: string,
  restore: () => void | Promise<void>,
) {
  const watchdog = new AbortController();
  const cleanup = disposeDurableObjects({ timeoutMs: 50 }).catch((error: unknown) => error);
  try {
    // 修正前も後始末できるよう、期限の検証とは別に試験の待ちを打ち切ります。
    const result: unknown = await Promise.race([
      cleanup,
      delay(500, "did not time out", { signal: watchdog.signal }),
    ]);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("Durable Object cleanup timed out after 50ms");
    expect((result as Error).message).toContain("GAME_ROOM");
    expect((result as Error).message).toContain(stub.id.name);
    expect((result as Error).message).toContain(stub.id.toString());
    expect((result as Error).message).toContain(waiting);
  } finally {
    watchdog.abort();
    await runInDurableObject(stub, restore);
    await cleanup;
    env.GAME_ROOM.get(stub.id);
    await disposeDurableObjects();
  }
}

test("戻らないジョブはDO名・ID・ジョブ名を示して後片づけを失敗にする", async () => {
  const stub = env.GAME_ROOM.getByName("cleanup-stuck-job");
  env.GAME_ROOM.get(env.GAME_ROOM.idFromString(stub.id.toString()));
  const restore = await runInDurableObject(stub, (instance) => {
    const { jobs } = Reflect.get(instance, "runtime") as RoomRuntime;
    let release: () => void;
    jobs.roomIndexJob.running = new Promise<void>((resolve) => (release = resolve));
    return () => {
      release();
      jobs.roomIndexJob.running = null;
    };
  });
  await expectCleanupTimeout(stub, "roomIndexJob", restore);
});

test("戻らないAlarm同期もDO名・ID・待ちの種類を示して失敗にする", async () => {
  const stub = env.GAME_ROOM.getByName("cleanup-stuck-alarm-sync");
  const restore = await runInDurableObject(stub, (instance) => {
    const { alarms } = Reflect.get(instance, "runtime") as RoomRuntime;
    let release: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sync = vi.spyOn(alarms, "sync").mockReturnValue(gate);
    return () => {
      sync.mockRestore();
      release();
    };
  });
  await expectCleanupTimeout(stub, "alarms.sync", restore);
});

test("後片づけ中のDO再登録が続いても全体の期限で失敗にする", async () => {
  const name = "cleanup-repeating-lookup";
  const stub = env.GAME_ROOM.getByName(name);
  const restore = await runInDurableObject(stub, (instance) => {
    const { alarms } = Reflect.get(instance, "runtime") as RoomRuntime;
    const sync = vi.spyOn(alarms, "sync").mockImplementation(async () => {
      env.GAME_ROOM.getByName(name);
    });
    return () => sync.mockRestore();
  });
  await expectCleanupTimeout(stub, "pending", restore);
});

test("解決済みのジョブが残り続けてもタイマーを飢餓させず失敗にする", async () => {
  const stub = env.GAME_ROOM.getByName("cleanup-resolved-job-loop");
  const restore = await runInDurableObject(stub, (instance) => {
    const { jobs } = Reflect.get(instance, "runtime") as RoomRuntime;
    jobs.roomIndexJob.running = Promise.resolve();
    return () => {
      jobs.roomIndexJob.running = null;
    };
  });
  await expectCleanupTimeout(stub, "roomIndexJob", restore);
});

test("偽時計でも後片づけの期限を止めない", async () => {
  const stub = env.GAME_ROOM.getByName("cleanup-fake-timers");
  const restore = await runInDurableObject(stub, (instance) => {
    const { jobs } = Reflect.get(instance, "runtime") as RoomRuntime;
    jobs.roomIndexJob.running = new Promise(() => {});
    return () => {
      jobs.roomIndexJob.running = null;
    };
  });
  vi.useFakeTimers();
  try {
    await expectCleanupTimeout(stub, "roomIndexJob", restore);
  } finally {
    vi.useRealTimers();
  }
});

test("終了しないAlarmのイベント名を示して失敗にする", async () => {
  const stub = env.GAME_ROOM.getByName("cleanup-stuck-alarm-event");
  const restore = await runInDurableObject(stub, (instance, state) => {
    const runtime = Reflect.get(instance, "runtime") as RoomRuntime;
    let release: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reconcile = vi.spyOn(runtime, "reconcileDeadlines").mockReturnValue(gate);
    const event = instance.alarm();
    state.waitUntil(event);
    return async () => {
      reconcile.mockRestore();
      release();
      await event;
    };
  });
  await expectCleanupTimeout(stub, "GameRoom.alarm", restore);
});

test.each(["webSocketClose", "webSocketError"] as const)(
  "終了しない%sのイベント名を示して失敗にする",
  async (name) => {
    const fixtures = new RoomBoundaryFixtures();
    const entry = await fixtures.create({ game: "shogi", name: "ホスト", quickPlay: true });
    await fixtures.connect(entry);
    const stub = env.GAME_ROOM.getByName(entry.room.id);
    const restore = await runInDurableObject(stub, (instance, state) => {
      const runtime = Reflect.get(instance, "runtime") as RoomRuntime;
      let release: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const reconcile = vi.spyOn(runtime, "reconcileDeadlines").mockReturnValue(gate);
      const socket = state.getWebSockets()[0]!;
      const event =
        name === "webSocketClose"
          ? instance.webSocketClose(socket, 1000, "test complete")
          : instance.webSocketError(socket);
      state.waitUntil(event);
      return async () => {
        reconcile.mockRestore();
        release();
        await event;
      };
    });
    await expectCleanupTimeout(stub, name, restore);
  },
);
