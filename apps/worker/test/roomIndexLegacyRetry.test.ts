import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { lobbyRoomCardsSchema } from "@tetraboard/protocol/general-lobby";
import { beforeEach, expect, test, vi } from "vitest";
import { indexRevisionKey, pendingIndexKey } from "../src/adapters/room/indexJob";
import type { RoomRuntime } from "../src/durableObjects/gameRoom/runtime";
import { writeRoomIndex, type PendingRoomIndex } from "../src/adapters/room/roomIndexWrite";
import { waitingRoomFactories } from "../src/adapters/room/waitingRoomFactories";
import { fixTestTime } from "./fixedTimeFixture";
import { boundaryRequest } from "./roomBoundaryFixtures";
import { unusedRoomId } from "./unusedRoomId";

const hostTokenHash = "a".repeat(64);

beforeEach(() => {
  // 手動実行より先に実時間の Alarm が発火しないようにします。
  fixTestTime(Date.now() + 60 * 60 * 1000);
});

async function createLiveRoom() {
  const code = await unusedRoomId();
  const stub = env.GAME_ROOM.getByName(code);
  const room = waitingRoomFactories.reversi({
    code,
    name: "現在のホスト",
    request: { game: "reversi", quickPlay: false },
  });
  expect(await stub.createRoom(room, hostTokenHash)).not.toBeNull();
  return { room, stub };
}

function readIndex(roomId: string) {
  return env.APP_DB.prepare(
    "SELECT closed, instance_id, revision, host_name, updated_at_ms FROM room_index WHERE room_id=?",
  )
    .bind(roomId)
    .first();
}

function storeLegacyJob(
  ctx: DurableObjectState,
  metadata: PendingRoomIndex["metadata"],
  revision: number,
) {
  const job = { metadata, revision, closed: false, retryAtMs: Date.now() - 1 };
  ctx.storage.kv.put(indexRevisionKey, revision);
  ctx.storage.kv.put(pendingIndexKey, job);
  return job;
}

test.each([false, true])(
  "Alarm は旧形式の公開索引を現在の世代と表示情報で再発行する（D1反映済み=%s）",
  async (alreadyPublished) => {
    const { room, stub } = await createLiveRoom();
    try {
      const metadata = { ...(await stub.getPublicMetadata())!, hostName: "旧名" };
      const job = await runInDurableObject(stub, async (instance, ctx) => {
        const runtime = Reflect.get(instance, "runtime") as RoomRuntime;
        await runtime.jobs.roomIndexJob.running;
        const pending = storeLegacyJob(
          ctx,
          metadata,
          ctx.storage.kv.get<number>(indexRevisionKey)! + 1,
        );
        await ctx.storage.setAlarm(Date.now() + 60_000);
        return pending;
      });
      if (alreadyPublished) await writeRoomIndex(env.APP_DB, job);

      expect(await runDurableObjectAlarm(stub)).toBe(true);
      await vi.waitFor(async () => {
        expect(await readIndex(room.id)).toEqual({
          closed: 0,
          instance_id: room.instanceId,
          revision: job.revision + 1,
          host_name: "現在のホスト",
          updated_at_ms: room.publicUpdatedAtMs,
        });
      });
      const response = await boundaryRequest("/lobby/rooms?view=cards&game=reversi");
      expect(response.status).toBe(200);
      const listed = lobbyRoomCardsSchema.parse(await response.json());
      expect(listed.rooms.find(({ id }) => id === room.id)).toMatchObject({
        instanceId: room.instanceId,
        hostName: "現在のホスト",
      });
      expect(await readIndex(room.id)).toMatchObject({ revision: job.revision + 1 });
    } finally {
      expect(await stub.leaveRoom(hostTokenHash)).toBe("left");
    }
  },
);

test.each([
  { label: "一致する旧公開行", index: { revision: 1, closed: false }, closes: true },
  { label: "索引なし" },
  { label: "版が新しい旧公開行", index: { revision: 2, closed: false } },
  {
    label: "同じ版で世代IDがある公開行",
    index: { revision: 1, closed: false, instanceId: crypto.randomUUID() },
  },
  { label: "閉鎖済みの旧行", index: { revision: 1, closed: true } },
])("DO にルームがなければ一致する旧公開行だけを閉じる（$label）", async ({ index, closes }) => {
  const id = await unusedRoomId();
  const metadata = {
    id,
    game: "reversi",
    timeControl: { mainTimeMs: 300_000, byoyomiMs: 0 },
    status: "waiting",
    hostName: "旧名",
    hostAvatarUrl: null,
    humanCount: 1,
    cpuCount: 0,
    capacity: 2,
    openSeats: 1,
    updatedAtMs: 1000,
  } satisfies PendingRoomIndex["metadata"];
  if (index) {
    await writeRoomIndex(env.APP_DB, {
      metadata: { ...metadata, instanceId: index.instanceId },
      revision: index.revision,
      closed: index.closed,
      retryAtMs: 0,
    });
  }
  const before = await readIndex(id);
  const stub = env.GAME_ROOM.getByName(id);
  await runInDurableObject(stub, async (_, ctx) => {
    storeLegacyJob(ctx, metadata, 1);
    await ctx.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await vi.waitFor(async () => {
    expect(
      await runInDurableObject(stub, (_, ctx) => ctx.storage.kv.get(pendingIndexKey)),
    ).toBeUndefined();
  });
  expect(await readIndex(id)).toEqual(closes ? { ...before, closed: 1 } : before);
});

test("Alarm の同期中に保留ジョブの版が進んだら古いジョブは索引を更新しない", async () => {
  const { room, stub } = await createLiveRoom();
  try {
    const metadata = { ...(await stub.getPublicMetadata())!, hostName: "旧名" };
    await runInDurableObject(stub, async (instance, ctx) => {
      const runtime = Reflect.get(instance, "runtime") as RoomRuntime;
      await runtime.jobs.roomIndexJob.running;
      const before = await readIndex(room.id);
      const old = storeLegacyJob(ctx, metadata, ctx.storage.kv.get<number>(indexRevisionKey)! + 1);
      const syncing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const sync = vi.spyOn(runtime.alarms, "sync").mockImplementationOnce(async () => {
        syncing.resolve();
        await release.promise;
      });
      const running = runtime.jobs.roomIndexJob.flush();
      try {
        await syncing.promise;
        const latest = {
          ...old,
          revision: old.revision + 1,
          metadata: { ...metadata, instanceId: room.instanceId },
          retryAtMs: Date.now() + 60_000,
        };
        ctx.storage.kv.put(indexRevisionKey, latest.revision);
        ctx.storage.kv.put(pendingIndexKey, latest);
        release.resolve();
        await running;
        expect(ctx.storage.kv.get(pendingIndexKey)).toEqual(latest);
        expect(await readIndex(room.id)).toEqual(before);
      } finally {
        release.resolve();
        await running;
        sync.mockRestore();
        ctx.storage.kv.delete(pendingIndexKey);
      }
    });
  } finally {
    expect(await stub.leaveRoom(hostTokenHash)).toBe("left");
  }
});
