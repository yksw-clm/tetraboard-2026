import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { GameRoom } from "../src/durableObjects/gameRoom/gameRoom";
import type { RoomRuntime } from "../src/durableObjects/gameRoom/runtime";
import { MatchmakingCoordinator } from "../src/matchmaking/coordinator";
import { TournamentCoordinator } from "../src/tournaments/coordinator";

const pending = new Map<DurableObjectNamespace, Map<string, DurableObjectId>>();
const originalGets = new Map<DurableObjectNamespace, DurableObjectNamespace["get"]>();
const backgroundEvents = new WeakMap<object, Set<Promise<unknown>>>();
const retired = new Set<string>();

function trackBackgroundEvent<T>(instance: object, result: Promise<T>): Promise<T> {
  let events = backgroundEvents.get(instance);
  if (!events) backgroundEvents.set(instance, (events = new Set()));
  events.add(result);
  void result.then(
    () => events.delete(result),
    () => events.delete(result),
  );
  return result;
}

// deleteAlarmでは配信済みのイベントを取り消せないため、終了済みfixtureへの遅着を止めます。
for (const type of [GameRoom, MatchmakingCoordinator, TournamentCoordinator]) {
  const method = type.prototype.alarm;
  Object.defineProperty(type.prototype, "alarm", {
    configurable: true,
    writable: true,
    value: function (this: { ctx: DurableObjectState }, ...args: unknown[]) {
      if (retired.has(this.ctx.id.toString())) return Promise.resolve();
      return trackBackgroundEvent(this, Reflect.apply(method, this, args));
    },
  });
}

// 接続一覧から消えた後も、切断イベントは保存やAlarmの再設定を続けます。
for (const name of ["webSocketClose", "webSocketError"] as const) {
  const method = GameRoom.prototype[name];
  Object.defineProperty(GameRoom.prototype, name, {
    configurable: true,
    writable: true,
    value: function (this: GameRoom, ...args: unknown[]) {
      if (retired.has((this as unknown as { ctx: DurableObjectState }).ctx.id.toString()))
        return Promise.resolve();
      const result: Promise<void> = Reflect.apply(method, this, args);
      return trackBackgroundEvent(this, result);
    },
  });
}

async function finishRoomWork(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.deleteAlarm();
    for (const socket of state.getWebSockets()) socket.close(1000, "test complete");
    await vi.waitUntil(() => state.getWebSockets().length === 0);
    while (backgroundEvents.get(instance)?.size) await Promise.all(backgroundEvents.get(instance)!);
    const runtime = (instance as unknown as { runtime?: RoomRuntime }).runtime;
    if (!runtime) return;
    let running: Promise<void>[];
    do {
      running = Object.values(runtime.jobs).flatMap((job) => job.running ?? []);
      await Promise.all(running);
      await runtime.alarms.sync();
    } while (running.length);
  });
}

export async function disposeDurableObjects(): Promise<void> {
  const stubs = new Map<string, DurableObjectStub>();
  while (pending.size) {
    const entries = [...pending];
    pending.clear();
    for (const [namespace, ids] of entries) {
      const get = originalGets.get(namespace)!;
      for (const id of ids.values()) {
        const stub = Reflect.apply(get, namespace, [id]);
        stubs.set(stub.id.toString(), stub);
        await finishRoomWork(stub);
      }
    }
  }
  for (const stub of stubs.values()) retired.add(stub.id.toString());
  for (const stub of stubs.values()) {
    await finishRoomWork(stub);
    await runInDurableObject(stub, async (_, state) => {
      await state.storage.deleteAlarm();
      await state.storage.sync();
    });
  }
  if (pending.size) await disposeDurableObjects();
}

export async function resetDurableObjectStorage(stub: DurableObjectStub): Promise<void> {
  await finishRoomWork(stub);
  retired.add(stub.id.toString());
  await runInDurableObject(stub, async (_, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
    await state.storage.sync();
  });
  // SQLiteのスキーマも消えるため、初期化済みのStoreを持つインスタンスを再利用しません。
  await evictDurableObject(stub, { webSockets: "close" });
}

export function trackDurableObjects(): () => Promise<void> {
  const restore: (() => void)[] = [];
  const active = new Set<string>();
  for (const namespace of [
    env.GAME_ROOM,
    env.MATCHMAKING_COORDINATOR,
    env.TOURNAMENT_COORDINATOR,
    env.CPU_CAPACITY,
  ] as DurableObjectNamespace[]) {
    const get = namespace.get;
    const getByName = namespace.getByName;
    originalGets.set(namespace, get);
    const remember = (stub: DurableObjectStub) => {
      const id = stub.id.toString();
      if (!active.has(id)) {
        active.add(id);
        retired.delete(id);
      }
      let ids = pending.get(namespace);
      if (!ids) pending.set(namespace, (ids = new Map()));
      ids.set(stub.id.toString(), stub.id);
      return stub;
    };
    namespace.get = function (...args) {
      return remember(Reflect.apply(get, this, args));
    };
    namespace.getByName = function (...args) {
      return remember(Reflect.apply(getByName, this, args));
    };
    restore.push(() => {
      namespace.get = get;
      namespace.getByName = getByName;
    });
  }
  return async () => {
    try {
      await disposeDurableObjects();
    } finally {
      for (const reset of restore) reset();
      originalGets.clear();
    }
  };
}
