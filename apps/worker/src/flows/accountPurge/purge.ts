import { playerTokenHash, readRoom } from "../../adapters/room/state";
import { withIndexTransaction } from "../../adapters/room/transaction";
import { broadcastChat } from "../../durableObjects/gameRoom/chat";
import { closeSockets } from "../../durableObjects/gameRoom/connections";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { broadcastRoom } from "../../durableObjects/gameRoom/snapshots";
import {
  accountKey,
  membershipStorageKey,
  playerTokenKey,
} from "../../durableObjects/gameRoom/storageKeys";
import { nextPublicUpdateAt, roomStorageKey } from "../../rooms/progressHelpers";
import { accountCleanupKey, type AccountCleanup } from "../accountSeats/types";
import { discoverPurgeTargets } from "./discover";
import { strip } from "./strip";
import { loadPurgeTargets } from "./targets";
import type { PurgeTargets } from "./types";

export async function purgeAccount(runtime: RoomRuntime, accountId: string) {
  await runtime.ctx.blockConcurrencyWhile(async () => {
    const targets = await loadPurgeTargets(runtime, accountId);
    await discoverPurgeTargets(runtime, targets);
    if (!targets.found) return;
    const removedKeys = revokeCredentials(runtime, targets);
    purgeStoredIdentities(runtime, targets, removedKeys);
    publishPurge(runtime);
  });
}

function revokeCredentials(runtime: RoomRuntime, targets: PurgeTargets) {
  const { ids } = targets;
  const removedKeys = new Set<string>();
  for (const id of ids) {
    const token = playerTokenHash(runtime, id);
    if (token) {
      removedKeys.add(membershipStorageKey(token));
      removedKeys.add(playerTokenKey(id));
      closeSockets(runtime, token, "Account deleted");
      runtime.ctx.storage.kv.delete(membershipStorageKey(token));
      runtime.ctx.storage.kv.delete(playerTokenKey(id));
    }
    runtime.ctx.storage.kv.delete(accountKey(id));
  }
  return removedKeys;
}

function purgeStoredIdentities(
  runtime: RoomRuntime,
  targets: PurgeTargets,
  removedKeys: ReadonlySet<string>,
) {
  const { entries, ids, accountIds } = targets;
  for (const [key, value] of entries) {
    if (removedKeys.has(key)) continue;
    if (key.startsWith("profile-ratings:") && value && typeof value === "object") {
      runtime.ctx.storage.kv.put(
        key,
        Object.fromEntries(Object.entries(value).filter(([id]) => !ids.has(id))),
      );
      continue;
    }
    if (
      key.startsWith("seat-account:") &&
      value &&
      typeof value === "object" &&
      "accountId" in value &&
      accountIds.has(String(value.accountId))
    )
      continue;
    if (key === accountCleanupKey) {
      runtime.ctx.storage.kv.put(
        key,
        (value as AccountCleanup[]).filter((v) => !accountIds.has(v.reservation.accountId)),
      );
      continue;
    }
    runtime.ctx.storage.kv.put(key, strip(runtime, targets, value));
  }
}

function publishPurge(runtime: RoomRuntime) {
  withIndexTransaction(runtime, (room) => {
    if (room)
      runtime.ctx.storage.kv.put(roomStorageKey, {
        ...room,
        publicUpdatedAtMs: nextPublicUpdateAt(room),
      });
  });
  const room = readRoom(runtime);
  if (room) broadcastRoom(runtime, room);
  broadcastChat(runtime);
}
