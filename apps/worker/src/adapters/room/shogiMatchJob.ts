import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { RoomJob } from "../../rooms/roomJobs";
import {
  advanceShogiMatchSave,
  pendingShogiMatchPrefix,
  pendingStandardShogiMatchPrefix,
  type PendingShogiMatch,
  type PendingStandardShogiMatch,
} from "../../rooms/shogiMatchStore";
import { readRoom } from "./state";

export function pendingShogiMatches(runtime: RoomRuntime) {
  return new Map([
    ...runtime.ctx.storage.kv.list<PendingShogiMatch | PendingStandardShogiMatch>({
      prefix: pendingShogiMatchPrefix,
    }),
    ...runtime.ctx.storage.kv.list<PendingShogiMatch | PendingStandardShogiMatch>({
      prefix: pendingStandardShogiMatchPrefix,
    }),
  ]);
}

export function createShogiMatchJob(runtime: RoomRuntime) {
  return new RoomJob(runtime.alarms, {
    pending: () => pendingShogiMatches(runtime),
    retryAt: ([, job]) => job.retryAtMs,
    mode: "single",
    sync: "always",
    execute: ([, job]) =>
      advanceShogiMatchSave(
        runtime.db,
        job.record,
        job.progress,
        (cursor) => runtime.gameAdapter(job.record).replayEvents(job.record.id, cursor),
        "formationUsage" in job ? job.formationUsage : undefined,
        "tournament" in job ? job.tournament : undefined,
      ),
    complete: ([key, job], progress) =>
      runtime.ctx.storage.transactionSync(() => {
        const latest = pendingShogiMatches(runtime).get(key);
        if (!latest) return;
        if (progress)
          runtime.ctx.storage.kv.put(key, { ...latest, progress, retryAtMs: Date.now() + 1 });
        else {
          runtime.ctx.storage.kv.delete(key);
          const room = readRoom(runtime);
          const keep = Boolean(room && runtime.gameAdapter(room).keepsArchive(room, job.record.id));
          runtime.gameAdapter(job.record).releaseArchive(job.record.id, keep);
        }
      }),
    retry: ([key, job], retryAtMs) => {
      console.error("Shogi match save will be retried", job.record.id);
      const latest = pendingShogiMatches(runtime).get(key);
      if (latest) runtime.ctx.storage.kv.put(key, { ...latest, retryAtMs });
    },
  });
}
