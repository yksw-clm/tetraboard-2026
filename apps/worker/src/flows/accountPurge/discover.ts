import { queuePendingDeletionImage } from "../../adapters/privacy/deletionJobs";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import type { PurgeTargets } from "./types";
import { identityScope } from "./identityScope";
import type { StoredAccountSeat } from "../accountSeats/types";

export async function discoverPurgeTargets(runtime: RoomRuntime, targets: PurgeTargets) {
  for (const [key, value] of targets.entries) {
    await prepareSeatPurge(runtime, targets, key, value);
    await discover(runtime, targets, value);
  }
}

async function prepareSeatPurge(
  runtime: RoomRuntime,
  targets: PurgeTargets,
  key: string,
  value: unknown,
) {
  const { accountIds, accountId, ids } = targets;
  if (
    key.startsWith("seat-account:") &&
    value &&
    typeof value === "object" &&
    "accountId" in value &&
    accountIds.has(String(value.accountId))
  ) {
    const seat = value as StoredAccountSeat;
    if (seat.occupying) throw new Error("Account still seated");
    ids.add(seat.playerId);
    if (seat.avatarKey) await queuePendingDeletionImage(runtime.db, accountId, seat.avatarKey);
    await runtime.db
      .prepare("DELETE FROM room_avatar_refs WHERE operation_id=? AND instance_id=?")
      .bind(seat.operationId, seat.instanceId)
      .run();
  }
}

async function discover(
  runtime: RoomRuntime,
  targets: PurgeTargets,
  v: unknown,
  inheritedScope?: ReadonlySet<string>,
): Promise<void> {
  const { accountIds, accountId, ids, names } = targets;
  if (Array.isArray(v)) {
    for (const item of v) await discover(runtime, targets, item, inheritedScope);
  } else if (v && typeof v === "object") {
    const row = v as Record<string, unknown>;
    const scope = identityScope(runtime, targets, row, inheritedScope);
    const matchingIds = scope ?? ids;
    if (
      accountIds.has(String(row.accountId)) ||
      matchingIds.has(String(row.id)) ||
      matchingIds.has(String(row.playerId)) ||
      matchingIds.has(String(row.senderId)) ||
      matchingIds.has(String(row.hostPlayerId))
    ) {
      targets.found = true;
      if (typeof row.id === "string") ids.add(row.id);
      if (typeof row.playerId === "string") ids.add(row.playerId);
      if (typeof row.name === "string") names.add(row.name);
      if (typeof row.hostName === "string") names.add(row.hostName);
      if (typeof row.avatarKey === "string")
        await queuePendingDeletionImage(runtime.db, accountId, row.avatarKey);
      if (typeof row.operationId === "string")
        await runtime.db
          .prepare("DELETE FROM room_avatar_refs WHERE operation_id=?")
          .bind(row.operationId)
          .run();
    }
    for (const value of Object.values(row)) await discover(runtime, targets, value, scope);
  }
}
