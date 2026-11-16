import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { writeRoomIndex, type PendingRoomIndex } from "../../rooms/roomIndex";
import { RoomJob } from "../../rooms/roomJobs";
import { publicMetadata } from "./metadata";
import { readRoom } from "./state";
export const indexRevisionKey = "room-index-revision";
export const pendingIndexKey = "room-index-pending";
export function createRoomIndexJob(runtime: RoomRuntime) {
  return new RoomJob(runtime.alarms, {
    pending: () => {
      const job = runtime.ctx.storage.kv.get<PendingRoomIndex>(pendingIndexKey);
      return job ? [job] : [];
    },
    retryAt: (job) => job.retryAtMs,
    execute: (job) => writeRoomIndex(runtime.db, job),
    complete: (job) => updatePendingIndex(runtime, job),
    retry: (job, retryAtMs, error) => {
      console.error("Room index update failed", error);
      updatePendingIndex(runtime, job, retryAtMs);
    },
  });
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
    // 番号が再利用された後の行や、新しいrevisionは閉じません。
    await runtime.alarms.sync();
    await runtime.db
      .prepare("UPDATE room_index SET closed=1 WHERE room_id=? AND instance_id IS ? AND revision=?")
      .bind(runtime.ctx.id.name, expectedInstanceId, expectedRevision)
      .run();
    return;
  }
  runtime.ctx.storage.transactionSync(() => {
    const revision =
      Math.max(runtime.ctx.storage.kv.get<number>(indexRevisionKey) ?? 0, expectedRevision) + 1;
    runtime.ctx.storage.kv.put(indexRevisionKey, revision);
    runtime.ctx.storage.kv.put(pendingIndexKey, {
      revision,
      closed: false,
      metadata: publicMetadata(runtime, room),
      retryAtMs: Date.now(),
    } satisfies PendingRoomIndex);
  });
  runtime.alarms.mark();
  await runtime.jobs.roomIndexJob.flush();
}
