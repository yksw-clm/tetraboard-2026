import { playerTokenHash, readRoom } from "../../adapters/room/state";
import { withIndexTransaction } from "../../adapters/room/transaction";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import {
  activeRegistrationKey,
  cancelledRegistrationKey,
  guestRegistrationState,
  registrationKey,
  type GuestRegistrationState,
  type StoredGuestRegistration,
} from "../../adapters/account/registrationTypes";
import { storedAccount } from "../accountSeats/seats";

export function registrationForPlayer(
  runtime: RoomRuntime,
  playerId: string,
): StoredGuestRegistration | null {
  const id = runtime.ctx.storage.kv.get<string>(activeRegistrationKey(playerId));
  if (!id) return null;
  const record = runtime.ctx.storage.kv.get<StoredGuestRegistration>(registrationKey(id));
  return record?.state === "pending" ? record : null;
}

export function endRegistration(
  runtime: RoomRuntime,
  record: StoredGuestRegistration,
  state: "cancelled" | "expired" | "released",
) {
  runtime.ctx.storage.kv.put(registrationKey(record.registrationId), { ...record, state });
  if (runtime.ctx.storage.kv.get(activeRegistrationKey(record.playerId)) === record.registrationId)
    runtime.ctx.storage.kv.delete(activeRegistrationKey(record.playerId));
}

export function releaseRegistration(runtime: RoomRuntime, playerId: string) {
  const record = registrationForPlayer(runtime, playerId);
  if (record) endRegistration(runtime, record, "released");
}

export function registrationView(
  runtime: RoomRuntime,
  record: StoredGuestRegistration,
): GuestRegistrationState {
  const result = guestRegistrationState(record);
  if (record.state === "converted") {
    const room = readRoom(runtime);
    const seat = storedAccount(runtime, record.playerId);
    if (
      room?.instanceId !== record.instanceId ||
      !seat?.occupying ||
      seat.accountId !== record.accountId ||
      playerTokenHash(runtime, record.playerId) !== record.newTokenHash
    )
      result.state = "released";
  }
  return result;
}

export async function getGuestRegistration(
  runtime: RoomRuntime,
  registrationId: string,
): Promise<GuestRegistrationState | null> {
  await runtime.reconcileDeadlines();
  const record = runtime.ctx.storage.kv.get<StoredGuestRegistration>(
    registrationKey(registrationId),
  );
  return record ? registrationView(runtime, record) : null;
}

export async function validateGuestRegistrationAccount(
  runtime: RoomRuntime,
  registrationId: string,
  accountId: string,
): Promise<"eligible" | "conflict" | "not_found" | "cancelled" | "expired"> {
  const record = runtime.ctx.storage.kv.get<StoredGuestRegistration>(
    registrationKey(registrationId),
  );
  if (!record) return "not_found";
  if (record.state === "cancelled") return "cancelled";
  if (record.claimUntilMs <= Date.now()) return "expired";
  if (
    (record.accountId && record.accountId !== accountId) ||
    record.originalAccountIds.includes(accountId)
  )
    return "conflict";
  return "eligible";
}

export async function cancelGuestRegistration(
  runtime: RoomRuntime,
  registrationId: string,
): Promise<GuestRegistrationState | null> {
  await runtime.reconcileDeadlines();
  withIndexTransaction(runtime, () => {
    const record = runtime.ctx.storage.kv.get<StoredGuestRegistration>(
      registrationKey(registrationId),
    );
    if (record?.state !== "converted")
      runtime.ctx.storage.kv.put(cancelledRegistrationKey(registrationId), true);
    if (record?.state === "pending") endRegistration(runtime, record, "cancelled");
  });
  // 解除後は元の切断時刻に戻し、既に過ぎた通常期限も同じ呼出しで処理します。
  await runtime.reconcileDeadlines();
  const record = runtime.ctx.storage.kv.get<StoredGuestRegistration>(
    registrationKey(registrationId),
  );
  return record ? registrationView(runtime, record) : null;
}
