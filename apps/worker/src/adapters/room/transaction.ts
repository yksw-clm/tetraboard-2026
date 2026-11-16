import { type Room } from "@tetraboard/protocol";
import type { RoomCpuCapacity, RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { cpuCapacityKey } from "../../durableObjects/gameRoom/storageKeys";
import { accountCleanupKey, type AccountCleanup } from "../../flows/accountSeats/types";
import { type PendingRoomIndex } from "../../rooms/roomIndex";
import { pendingTournamentStatePrefix } from "../../rooms/tournamentRoom";
import { indexRevisionKey, pendingIndexKey } from "./indexJob";
import { pendingMatches } from "./matchJob";
import { publicMetadata } from "./metadata";
import { pendingShogiMatches } from "./shogiMatchJob";
import { readRoom } from "./state";

export function withIndexTransaction<T>(
  runtime: RoomRuntime,
  action: () => T,
  previousRoom?: Room | null,
): T {
  let changed = false;
  let releaseCpu = false;
  const result = runtime.usageEvents.run(() =>
    runtime.ctx.storage.transactionSync(() => {
      const before = previousRoom === undefined ? readRoom(runtime) : previousRoom;
      const previous = before === null ? null : publicMetadata(runtime, before);
      const value = action();
      const after = readRoom(runtime);
      if (
        after?.instanceId !== before?.instanceId ||
        (before?.status === "playing" && after?.status !== "playing")
      ) {
        const reservation = runtime.ctx.storage.kv.get<RoomCpuCapacity>(cpuCapacityKey);
        if (reservation?.releaseAtMs === null && reservation.instanceId === before?.instanceId) {
          runtime.ctx.storage.kv.put(cpuCapacityKey, { ...reservation, releaseAtMs: Date.now() });
          releaseCpu = true;
        }
      }
      changed =
        (before === null && after !== null) ||
        (before !== null && after === null) ||
        (before !== null && after !== null && after.publicUpdatedAtMs !== before.publicUpdatedAtMs);
      if (changed) {
        const revision = (runtime.ctx.storage.kv.get<number>(indexRevisionKey) ?? 0) + 1;
        const metadata = after === null ? previous : publicMetadata(runtime, after);
        if (metadata === null) throw new Error("Missing room metadata for index update");
        runtime.ctx.storage.kv.put(indexRevisionKey, revision);
        runtime.ctx.storage.kv.put(pendingIndexKey, {
          revision,
          closed: after === null,
          metadata,
          retryAtMs: Date.now(),
        } satisfies PendingRoomIndex);
      }
      return value;
    }),
  );
  runtime.alarms.mark();
  if (changed) runtime.ctx.waitUntil(runtime.jobs.roomIndexJob.flush());
  if (releaseCpu) runtime.ctx.waitUntil(runtime.jobs.cpuCapacityJob.flush());
  if ((runtime.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? []).length)
    runtime.ctx.waitUntil(runtime.jobs.accountCleanupJob.flush());
  if (pendingMatches(runtime).size) runtime.ctx.waitUntil(runtime.jobs.matchJob.flush());
  if (pendingShogiMatches(runtime).size) runtime.ctx.waitUntil(runtime.jobs.shogiMatchJob.flush());
  if ([...runtime.ctx.storage.kv.list({ prefix: pendingTournamentStatePrefix })].length)
    runtime.ctx.waitUntil(runtime.jobs.tournamentStateJob.flush());
  return result;
}
