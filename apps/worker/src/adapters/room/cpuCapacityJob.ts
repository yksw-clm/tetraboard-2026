import type { RoomCpuCapacity, RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { cpuCapacityKey } from "../../durableObjects/gameRoom/storageKeys";
import { RoomJob } from "../../rooms/roomJobs";

export function createCpuCapacityJob(runtime: RoomRuntime) {
  return new RoomJob(runtime.alarms, {
    sync: "due",
    pending: () => {
      const job = runtime.ctx.storage.kv.get<RoomCpuCapacity>(cpuCapacityKey);
      return job ? [job] : [];
    },
    retryAt: (job) => job.releaseAtMs,
    mode: "single",
    execute: (job) => runtime.cpuCapacity.getByName(job.game).release(job.roomId, job.sequence),
    complete: () => {
      runtime.ctx.storage.kv.delete(cpuCapacityKey);
    },
    retry: (job, releaseAtMs) =>
      runtime.ctx.storage.kv.put(cpuCapacityKey, { ...job, releaseAtMs }),
  });
}
