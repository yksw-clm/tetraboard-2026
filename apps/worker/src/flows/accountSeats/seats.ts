import type { AccountAdmission } from "../../accounts/roomAccounts";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { accountKey, cancelledAdmissionKey } from "../../durableObjects/gameRoom/storageKeys";
import { accountCleanupKey, type AccountCleanup, type StoredAccountSeat } from "./types";

export function storedAccount(runtime: RoomRuntime, playerId: string) {
  return runtime.ctx.storage.kv.get<StoredAccountSeat>(accountKey(playerId)) ?? null;
}

export function queueAccountCleanup(
  runtime: RoomRuntime,
  reservation: AccountAdmission,
  releaseAvatar: boolean,
) {
  const jobs = runtime.ctx.storage.kv.get<AccountCleanup[]>(accountCleanupKey) ?? [];
  const existing = jobs.find((job) => job.reservation.operationId === reservation.operationId);
  if (existing) existing.releaseAvatar ||= releaseAvatar;
  else jobs.push({ reservation, releaseAvatar, retryAtMs: Date.now() });
  runtime.ctx.storage.kv.put(accountCleanupKey, jobs);
  runtime.alarms.mark();
}

export function releaseAccount(runtime: RoomRuntime, playerId: string, removeAvatar: boolean) {
  const seat = storedAccount(runtime, playerId);
  if (!seat) return;
  runtime.ctx.storage.kv.put(cancelledAdmissionKey(seat.operationId), true);
  queueAccountCleanup(runtime, seat, removeAvatar);
  if (removeAvatar) runtime.ctx.storage.kv.delete(accountKey(playerId));
  else runtime.ctx.storage.kv.put(accountKey(playerId), { ...seat, occupying: false });
}
