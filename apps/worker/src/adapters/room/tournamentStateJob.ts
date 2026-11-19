import { writeTournamentState } from "../tournament/state";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { updatePendingTournamentState } from "../../flows/tournamentRoom/reservations";
import { RoomJob } from "./roomJobs";
import {
  pendingTournamentStatePrefix,
  type PendingTournamentState,
} from "@tetraboard/context-tournament";

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
