import { profileAvatarUrl } from "../../accounts/auth";
import type { AccountAdmission } from "./types";
import { readRoom } from "../../adapters/room/state";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { cancelledAdmissionKey } from "../../durableObjects/gameRoom/storageKeys";
import { queueAccountCleanup, storedAccount } from "./seats";

export async function accountReservationState(
  runtime: RoomRuntime,
  admission: AccountAdmission,
): Promise<"occupied" | "released" | "pending"> {
  await runtime.reconcileDeadlines();
  const seat = storedAccount(runtime, admission.playerId);
  if (seat?.operationId === admission.operationId) return seat.occupying ? "occupied" : "released";
  return runtime.ctx.storage.kv.get(cancelledAdmissionKey(admission.operationId))
    ? "released"
    : "pending";
}

export async function cancelAccountReservation(runtime: RoomRuntime, admission: AccountAdmission) {
  await runtime.reconcileDeadlines();
  return runtime.ctx.blockConcurrencyWhile(async () => {
    const seat = storedAccount(runtime, admission.playerId);
    if (seat?.operationId === admission.operationId && seat.occupying)
      return { occupied: true, avatarReferenced: true };
    const room = readRoom(runtime);
    const avatarReferenced =
      room?.instanceId === admission.instanceId &&
      (room.players.some(
        (player) =>
          player.id === admission.playerId &&
          player.kind === "human" &&
          player.avatarUrl === profileAvatarUrl(admission.avatarKey, admission.avatarPresetId),
      ) ||
        room.lastRound?.players.some(
          (player) =>
            player.id === admission.playerId &&
            player.appearance?.kind === "human" &&
            player.appearance.avatarUrl ===
              profileAvatarUrl(admission.avatarKey, admission.avatarPresetId),
        ));
    runtime.ctx.storage.transactionSync(() => {
      runtime.ctx.storage.kv.put(cancelledAdmissionKey(admission.operationId), true);
      queueAccountCleanup(runtime, admission, !avatarReferenced);
    });
    runtime.alarms.mark();
    return { occupied: false, avatarReferenced: Boolean(avatarReferenced) };
  });
}
