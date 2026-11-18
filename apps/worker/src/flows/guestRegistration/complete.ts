import type { AccountAdmission } from "../accountSeats/types";
import { readMembership, readRoom } from "../../adapters/room/state";
import { withIndexTransaction } from "../../adapters/room/transaction";
import { closeSockets } from "../../durableObjects/gameRoom/connections";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { broadcastRoom } from "../../durableObjects/gameRoom/snapshots";
import {
  registrationKey,
  type CompleteGuestRegistrationResult,
  type StoredGuestRegistration,
} from "../../rooms/registrationTypes";
import type { AnalyticsIdentity } from "../../usageEvents/matches";
import { withAccountAdmission } from "../accountSeats/admission";
import { completeRegistrationSeat } from "./completeSeat";
import { registrationView } from "./records";

export async function completeGuestRegistration(
  runtime: RoomRuntime,
  registrationId: string,
  admission: AccountAdmission,
  analytics?: AnalyticsIdentity,
): Promise<CompleteGuestRegistrationResult> {
  await runtime.reconcileDeadlines();
  const prior = completedRegistration(runtime, registrationId, admission);
  if (prior) return prior;
  const result = await withAccountAdmission(runtime, admission, () =>
    withIndexTransaction(runtime, (): CompleteGuestRegistrationResult => {
      const prior = completedRegistration(runtime, registrationId, admission);
      if (prior) return prior;
      return completeRegistrationSeat(runtime, registrationId, admission, analytics);
    }),
  );
  if (result?.status === "converted") {
    const record = runtime.ctx.storage.kv.get<StoredGuestRegistration>(
      registrationKey(registrationId),
    )!;
    closeSockets(runtime, record.oldTokenHash, "Room membership updated");
    const room = readRoom(runtime);
    if (room) broadcastRoom(runtime, room);
  } else await runtime.reconcileDeadlines();
  return result ?? { status: "account_reservation_invalid" };
}

function completedRegistration(
  runtime: RoomRuntime,
  registrationId: string,
  admission: AccountAdmission,
): CompleteGuestRegistrationResult | null {
  const record = runtime.ctx.storage.kv.get<StoredGuestRegistration>(
    registrationKey(registrationId),
  );
  if (!record) return { status: "not_found" };
  if (record.accountId && record.accountId !== admission.accountId)
    return { status: "account_conflict" };
  if (record.state === "converted") {
    const state = registrationView(runtime, record);
    const membership = readMembership(runtime, record.newTokenHash);
    return state.state === "converted" && membership
      ? { status: "converted", registration: state, membership }
      : { status: "released" };
  }
  if (record.state !== "pending") return { status: record.state };
  return null;
}
