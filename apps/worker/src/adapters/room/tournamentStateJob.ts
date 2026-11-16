import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { updatePendingTournamentState } from "../../flows/tournamentRoom/reservations";
import { RoomJob } from "../../rooms/roomJobs";
import {
  pendingTournamentStatePrefix,
  writeTournamentState,
  type PendingTournamentState,
} from "../../rooms/tournamentRoom";

export function createTournamentStateJob(runtime: RoomRuntime) {
  return new RoomJob(runtime.alarms, {
    pending: () =>
      runtime.ctx.storage.kv.list<PendingTournamentState>({ prefix: pendingTournamentStatePrefix }),
    retryAt: ([, job]) => job.retryAtMs,
    mode: "snapshot",
    stopOnFailure: false,
    execute: ([, job]) => writeTournamentState(runtime.db, job),
    complete: ([key, job]) => updatePendingTournamentState(runtime, key, job),
    retry: ([key, job], retryAtMs) => updatePendingTournamentState(runtime, key, job, retryAtMs),
  });
}
