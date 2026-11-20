import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import {
  finishGuestClaims,
  guestClaimsKey,
  runGuestClaims,
  type PendingGuestClaims,
} from "../../flows/guestRegistration/claims";
import { RoomJob } from "./roomJobs";

export function createGuestClaimsJob(runtime: RoomRuntime) {
  return new RoomJob(runtime.alarms, {
    canRun: () => Boolean(runtime.ctx.id.name),
    sync: "due",
    pending: () => {
      const job = runtime.ctx.storage.kv.get<PendingGuestClaims>(guestClaimsKey);
      return job ? [job] : [];
    },
    retryAt: (job) => job.retryAtMs,
    mode: "single",
    execute: () => runGuestClaims(runtime),
    complete: (job, pending) =>
      finishGuestClaims(runtime, job, pending ? Date.now() + 5_000 : null),
    retry: (job, retryAtMs) => {
      console.error("Guest match claims will be retried");
      finishGuestClaims(runtime, job, retryAtMs);
    },
  });
}
