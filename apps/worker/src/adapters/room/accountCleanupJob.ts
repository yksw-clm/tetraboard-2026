import { releaseReservation } from "./seatReservations";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { cancelledAdmissionKey } from "../../durableObjects/gameRoom/storageKeys";
import { accountCleanupKey, type AccountCleanup } from "../../flows/accountSeats/types";
import { RoomJob } from "../../rooms/roomJobs";

export function createAccountCleanupJob(runtime: RoomRuntime) {
  return new RoomJob(runtime.alarms, {
    pending: () => runtime.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [],
    retryAt: (job) => job.retryAtMs,
    execute: (job) =>
      releaseReservation(runtime.accountBindings, job.reservation, job.releaseAvatar),
    complete: (job) =>
      runtime.ctx.storage.transactionSync(() => {
        const jobs = runtime.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [];
        // D1の応答待ちに画像の解放が追加された場合は、次の実行へ残します。
        const latest = jobs.find(
          (entry) => entry.reservation.operationId === job.reservation.operationId,
        );
        if (latest && latest.releaseAvatar && !job.releaseAvatar) return;
        runtime.ctx.storage.kv.put(
          accountCleanupKey,
          jobs.filter((entry) => entry.reservation.operationId !== job.reservation.operationId),
        );
        runtime.ctx.storage.kv.delete(cancelledAdmissionKey(job.reservation.operationId));
      }),
    retry: (job, retryAtMs) => {
      console.error("Account seat cleanup will be retried");
      const jobs = runtime.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [];
      for (const entry of jobs)
        if (entry.reservation.operationId === job.reservation.operationId)
          entry.retryAtMs = retryAtMs;
      runtime.ctx.storage.kv.put(accountCleanupKey, jobs);
    },
  });
}
