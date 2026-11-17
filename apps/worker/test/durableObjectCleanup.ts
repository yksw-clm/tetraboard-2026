import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { GameRoom } from "../src/durableObjects/gameRoom/gameRoom";
import type { RoomRuntime } from "../src/durableObjects/gameRoom/runtime";
import { MatchmakingCoordinator } from "../src/durableObjects/matchmakingCoordinator/coordinator";
import { TournamentCoordinator } from "../src/durableObjects/tournamentCoordinator/coordinator";
import { CleanupDeadline, cleanupTimeoutMs } from "./cleanupDeadline";

const pending = new Map<DurableObjectNamespace, Map<string, DurableObjectId>>();
const originalGets = new Map<DurableObjectNamespace, DurableObjectNamespace["get"]>();
const backgroundEvents = new WeakMap<object, Map<Promise<unknown>, string>>();
const retired = new Set<string>();
const identities = new Map<string, string>();
let testName = "";

function trackBackgroundEvent<T>(instance: object, name: string, result: Promise<T>): Promise<T> {
  let events = backgroundEvents.get(instance);
  if (!events) backgroundEvents.set(instance, (events = new Map()));
  events.set(result, name);
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
      return trackBackgroundEvent(this, `${type.name}.alarm`, Reflect.apply(method, this, args));
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
      return trackBackgroundEvent(this, name, result);
    },
  });
}

function identity(stub: DurableObjectStub): string {
  return identities.get(stub.id.toString()) ?? `name=${stub.id.name ?? "(unnamed)"} id=${stub.id}`;
}

function deadline(timeoutMs: number): CleanupDeadline {
  return new CleanupDeadline(timeoutMs, () => {
    const ids = [...pending.values()].flatMap((ids) => [...ids.keys()]);
    return `test=${testName}; pending=[${ids.map((id) => identities.get(id) ?? id).join(", ")}]`;
  });
}

async function finishRoomWork(stub: DurableObjectStub, limit: CleanupDeadline): Promise<void> {
  let describeWork = () => "";
  const wait = <T>(stage: string, action: () => Promise<T>) =>
    limit.wait(() => `${identity(stub)} ${stage} ${describeWork()}`, action);
  await wait("runInDurableObject(finishRoomWork)", () =>
    runInDurableObject(stub, async (instance, state) => {
      const runtime = (instance as unknown as { runtime?: RoomRuntime }).runtime;
      const runningJobs = () =>
        Object.entries(runtime?.jobs ?? {}).flatMap(([name, job]) => (job.running ? [name] : []));
      describeWork = () =>
        `events=[${[...(backgroundEvents.get(instance)?.values() ?? [])].join(", ")}] jobs=[${runningJobs().join(", ")}]`;
      await wait("storage.deleteAlarm", () => state.storage.deleteAlarm());
      for (const socket of state.getWebSockets()) socket.close(1000, "test complete");
      while (state.getWebSockets().length) {
        await wait(`WebSocket close (${state.getWebSockets().length})`, () => limit.yield());
      }
      while (backgroundEvents.get(instance)?.size) {
        const events = backgroundEvents.get(instance)!;
        await limit.wait(
          () => `${identity(stub)} events=[${[...events.values()].join(", ")}]`,
          () => Promise.all(events.keys()),
        );
        await limit.yield();
      }
      if (!runtime) return;
      let running: [string, Promise<void>][];
      do {
        running = Object.entries(runtime.jobs).flatMap(([name, job]) =>
          job.running ? [[name, job.running] as [string, Promise<void>]] : [],
        );
        await wait(`jobs=[${running.map(([name]) => name).join(", ")}]`, () =>
          Promise.all(running.map(([, task]) => task)),
        );
        await wait("alarms.sync", () => runtime.alarms.sync());
        if (running.length) await limit.yield();
      } while (running.length);
    }),
  );
}

async function dispose(limit: CleanupDeadline): Promise<void> {
  const stubs = new Map<string, DurableObjectStub>();
  while (pending.size) {
    await limit.yield();
    const entries = [...pending];
    pending.clear();
    for (const [namespace, ids] of entries) {
      const get = originalGets.get(namespace)!;
      for (const id of ids.values()) {
        const stub = Reflect.apply(get, namespace, [id]);
        stubs.set(stub.id.toString(), stub);
        await finishRoomWork(stub, limit);
      }
    }
  }
  for (const stub of stubs.values()) retired.add(stub.id.toString());
  for (const stub of stubs.values()) {
    await finishRoomWork(stub, limit);
    await finishStorage(stub, limit);
  }
}

async function finishStorage(
  stub: DurableObjectStub,
  limit: CleanupDeadline,
  reset = false,
): Promise<void> {
  const wait = (stage: string, action: () => Promise<void>) =>
    limit.wait(() => `${identity(stub)} ${stage}`, action);
  await wait("runInDurableObject(storage)", () =>
    runInDurableObject(stub, async (_, state) => {
      if (reset) await wait("storage.deleteAll", () => state.storage.deleteAll());
      await wait("storage.deleteAlarm", () => state.storage.deleteAlarm());
      await wait("storage.sync", () => state.storage.sync());
    }),
  );
}

export async function disposeDurableObjects({ timeoutMs = cleanupTimeoutMs } = {}): Promise<void> {
  const limit = deadline(timeoutMs);
  await limit.wait(
    () => "disposeDurableObjects",
    async () => {
      do {
        await dispose(limit);
      } while (pending.size);
    },
  );
}

export async function resetDurableObjectStorage(stub: DurableObjectStub): Promise<void> {
  const limit = deadline(cleanupTimeoutMs);
  await finishRoomWork(stub, limit);
  retired.add(stub.id.toString());
  await finishStorage(stub, limit, true);
  // SQLiteのスキーマも消えるため、初期化済みのStoreを持つインスタンスを再利用しません。
  await limit.wait(
    () => `${identity(stub)} evictDurableObject`,
    () => evictDurableObject(stub, { webSockets: "close" }),
  );
}

export function trackDurableObjects(name = ""): () => Promise<void> {
  testName = name;
  identities.clear();
  const restore: (() => void)[] = [];
  const active = new Set<string>();
  for (const [binding, namespace] of Object.entries({
    GAME_ROOM: env.GAME_ROOM,
    MATCHMAKING_COORDINATOR: env.MATCHMAKING_COORDINATOR,
    TOURNAMENT_COORDINATOR: env.TOURNAMENT_COORDINATOR,
    CPU_CAPACITY: env.CPU_CAPACITY,
  }) as [string, DurableObjectNamespace][]) {
    const get = namespace.get;
    const getByName = namespace.getByName;
    originalGets.set(namespace, get);
    const remember = (stub: DurableObjectStub, name = stub.id.name) => {
      const id = stub.id.toString();
      if (name !== undefined || !identities.has(id))
        identities.set(id, `${binding} name=${name ?? "(unnamed)"} id=${id}`);
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
      return remember(Reflect.apply(getByName, this, args), args[0]);
    };
    restore.push(() => {
      namespace.get = get;
      namespace.getByName = getByName;
    });
  }
  return async () => {
    try {
      await disposeDurableObjects();
    } catch (error) {
      for (const id of active) retired.add(id);
      throw error;
    } finally {
      for (const reset of restore) reset();
      originalGets.clear();
      pending.clear();
    }
  };
}
