import type { Room } from "@tetraboard/protocol";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { roomStorageKey } from "../../rooms/progressHelpers";
import { writeRoomIndex, type PendingRoomIndex } from "./roomIndexWrite";
import { RoomJob } from "../../rooms/roomJobs";
import { publicMetadata } from "./metadata";
import type { RoomJobs } from "./jobs";
import { readRoom } from "./state";
export const indexRevisionKey = "room-index-revision";
export const pendingIndexKey = "room-index-pending";

export type RoomIndexRetentionStatus =
  | "ready"
  | "room-present"
  | "working"
  | "revision-mismatch"
  | keyof RoomJobs;

export function checkRoomIndexRetention(
  runtime: RoomRuntime,
  expectedRevision: number,
): RoomIndexRetentionStatus {
  const { kv } = runtime.ctx.storage;
  if (kv.get(roomStorageKey) !== undefined) return "room-present";
  if (runtime.alarms.hasActiveWork) return "working";
  for (const name of Object.keys(runtime.jobs) as (keyof RoomJobs)[]) {
    const job = runtime.jobs[name];
    if (job.running || job.hasPending()) return name;
  }
  // 番号の再利用時に、削除台帳を越える版を発行できることも確かめます。
  if (kv.get(indexRevisionKey) !== expectedRevision) return "revision-mismatch";
  return "ready";
}

export function createRoomIndexJob(runtime: RoomRuntime) {
  return new RoomJob(runtime.alarms, {
    pending: () => {
      const job = runtime.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey);
      return job ? [job] : [];
    },
    retryAt: (job) => job.retryAtMs,
    execute: (job) => publishPendingIndex(runtime, job),
    complete: (job) => updatePendingIndex(runtime, job),
    retry: (job, retryAtMs, error) => {
      console.error("Room index update failed", error);
      updatePendingIndex(runtime, job, retryAtMs);
    },
  });
}

async function publishPendingIndex(runtime: RoomRuntime, job: PendingRoomIndex) {
  if (job.closed || job.metadata.instanceId != null) return writeRoomIndex(runtime.db, job);

  const { storage } = runtime.ctx;
  const shouldClose = storage.transactionSync(() => {
    const current = storage.kv.get<PendingRoomIndex>(pendingIndexKey);
    if (current?.revision !== job.revision) return false;
    const room = readRoom(runtime);
    if (room === null) return true;

    // 旧版の書き込みがすでにD1へ届いていても、新しい版で置き換えます。
    queueLobbyIndex(runtime, room, current.revision, current.retryAtMs);
    return false;
  });
  if (shouldClose) await closeIndexedRoom(runtime.db, job.metadata.id, null, job.revision);
}

export function updatePendingIndex(
  runtime: RoomRuntime,
  job: PendingRoomIndex,
  retryAtMs?: number,
) {
  runtime.ctx.storage.transactionSync(() => {
    const current = runtime.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey);
    if (current?.revision !== job.revision) return;
    if (retryAtMs !== undefined)
      runtime.ctx.storage.kv.put(pendingIndexKey, { ...current, retryAtMs });
    else runtime.ctx.storage.kv.delete(pendingIndexKey);
  });
}

export async function refreshLobbyIndex(
  runtime: RoomRuntime,
  expectedInstanceId: string | null,
  expectedRevision: number,
) {
  const room = readRoom(runtime);
  if (room === null) {
    await runtime.alarms.sync();
    await closeIndexedRoom(runtime.db, runtime.ctx.id.name, expectedInstanceId, expectedRevision);
    return;
  }
  runtime.ctx.storage.transactionSync(() =>
    queueLobbyIndex(runtime, room, expectedRevision, Date.now()),
  );
  runtime.alarms.mark();
  await runtime.jobs.roomIndexJob.flush();
}

function queueLobbyIndex(
  runtime: RoomRuntime,
  room: Room,
  expectedRevision: number,
  retryAtMs: number,
) {
  const { kv } = runtime.ctx.storage;
  const revision = Math.max(kv.get<number>(indexRevisionKey) ?? 0, expectedRevision) + 1;
  kv.put(indexRevisionKey, revision);
  kv.put(pendingIndexKey, {
    revision,
    closed: false,
    metadata: publicMetadata(runtime, room),
    retryAtMs,
  } satisfies PendingRoomIndex);
}

function closeIndexedRoom(
  db: D1Database,
  roomId: string | undefined,
  expectedInstanceId: string | null,
  expectedRevision: number,
) {
  return db
    .prepare(
      "UPDATE room_index SET closed=1 WHERE room_id=? AND instance_id IS ? AND revision=? AND closed=0",
    )
    .bind(roomId, expectedInstanceId, expectedRevision)
    .run();
}
