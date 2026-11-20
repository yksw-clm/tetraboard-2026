import type { AccountAdmission } from "../accountSeats/types";
import { readMembership, readRoom } from "../../adapters/room/state";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import {
  guestRegistrationState,
  registrationKey,
  type CompleteGuestRegistrationResult,
  type StoredGuestRegistration,
} from "../../adapters/account/registrationTypes";
import type { AnalyticsIdentity } from "../../usageEvents/matches";
import { storedAccount } from "../accountSeats/seats";
import { persistRegistrationCredentials, updateRegistrationAppearance } from "./completeStorage";
import { registrationForPlayer } from "./records";

export function completeRegistrationSeat(
  runtime: RoomRuntime,
  registrationId: string,
  admission: AccountAdmission,
  analytics?: AnalyticsIdentity,
): CompleteGuestRegistrationResult {
  const record = runtime.ctx.storage.kv.get<StoredGuestRegistration>(
    registrationKey(registrationId),
  )!;
  const now = Date.now();
  if (record.holdUntilMs <= now) return { status: "expired" };
  const room = readRoom(runtime);
  if (
    !room ||
    room.instanceId !== record.instanceId ||
    room.instanceId !== admission.instanceId ||
    room.id !== admission.roomId
  )
    return { status: "room_changed" };
  const last = room.lastRound;
  const matchId = last && ("roundId" in last ? last.roundId : last.replay?.id);
  if (
    room.status !== "waiting" ||
    matchId !== record.matchId ||
    admission.playerId !== record.playerId ||
    registrationForPlayer(runtime, record.playerId)?.registrationId !== registrationId
  )
    return { status: "released" };
  const membership = readMembership(runtime, record.oldTokenHash);
  const existing = storedAccount(runtime, record.playerId);
  if (
    membership?.playerId !== record.playerId ||
    (record.guestAccountId
      ? existing?.accountId !== record.guestAccountId ||
        !existing.isGuest ||
        !existing.occupying ||
        existing.operationId !== admission.operationId
      : existing !== null)
  )
    return { status: "released" };
  if (readMembership(runtime, record.newTokenHash))
    return { status: "account_reservation_invalid" };
  const updatedRecord = persistRegistrationCredentials(
    runtime,
    registrationId,
    admission,
    analytics,
    record,
    membership,
    now,
  );
  updateRegistrationAppearance(runtime, admission, record, room, last, now);
  return {
    status: "converted",
    registration: guestRegistrationState(updatedRecord),
    membership,
  };
}
