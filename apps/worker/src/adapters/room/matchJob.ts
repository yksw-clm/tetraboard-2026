import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import type { PendingMatch as PendingFourGomokuMatch } from "../../rooms/fourGomokuMatchStore";
import type { PendingMatch as PendingGomokuMatch } from "../../rooms/gomokuMatchStore";
import { pendingMatchPrefix, type PendingMatch } from "../../rooms/matchStore";
import { writeMatch } from "../../flows/matchSave/snapshot";
import type { PendingMatch as PendingReversiMatch } from "../../rooms/reversiMatchStore";
import { RoomJob } from "./roomJobs";

export function pendingMatches(runtime: RoomRuntime) {
  return new Map(
    runtime.ctx.storage.kv.list<
      PendingMatch | PendingReversiMatch | PendingGomokuMatch | PendingFourGomokuMatch
    >({
      prefix: pendingMatchPrefix,
    }),
  );
}

export function createMatchJob(runtime: RoomRuntime) {
  return new RoomJob(runtime.alarms, {
    pending: () => pendingMatches(runtime),
    retryAt: ([, job]) => job.retryAtMs,
    execute: ([, job]) =>
      writeMatch(runtime.db, job.record, "tournament" in job ? job.tournament : undefined),
    complete: ([key]) => {
      runtime.ctx.storage.kv.delete(key);
    },
    retry: ([key, job], retryAtMs) => {
      console.error("Match save will be retried", job.record.id);
      const latest = pendingMatches(runtime).get(key);
      if (latest) runtime.ctx.storage.kv.put(key, { ...latest, retryAtMs });
    },
  });
}
