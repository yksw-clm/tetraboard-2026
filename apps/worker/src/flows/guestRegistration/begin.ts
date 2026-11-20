import { membershipTokenSchema } from "@tetraboard/protocol";
import { readRoom } from "../../adapters/room/state";
import { withIndexTransaction } from "../../adapters/room/transaction";
import type { RoomRuntime } from "../../durableObjects/gameRoom/runtime";
import { broadcastRoom } from "../../durableObjects/gameRoom/snapshots";
import {
  cancelledRegistrationKey,
  guestRegistrationState,
  registrationKey,
  registrationPrefix,
  type BeginGuestRegistrationResult,
  type GuestRegistrationInput,
  type StoredGuestRegistration,
} from "../../adapters/account/registrationTypes";
import { beginRegistrationSeat } from "./beginSeat";
import { originalMatchAccounts } from "./claims";
import { registrationView } from "./records";

export async function beginGuestRegistration(
  runtime: RoomRuntime,
  input: GuestRegistrationInput,
): Promise<BeginGuestRegistrationResult> {
  await runtime.reconcileDeadlines();
  const originalAccountIds = await originalMatchAccounts(runtime, input);
  const result = withIndexTransaction(runtime, (): BeginGuestRegistrationResult => {
    const previous = previousRegistration(runtime, input);
    if (previous) return previous;
    const now = Date.now();
    const retained = retainRegistrationClaim(runtime, input, now);
    if (retained) return retained;
    return beginRegistrationSeat(runtime, input, originalAccountIds, now);
  });
  const room = readRoom(runtime);
  if (room && result.status === "started") broadcastRoom(runtime, room);
  return result;
}

function previousRegistration(
  runtime: RoomRuntime,
  input: GuestRegistrationInput,
): BeginGuestRegistrationResult | null {
  if (runtime.ctx.storage.kv.get(cancelledRegistrationKey(input.registrationId)))
    return { status: "expired" };
  const previous = runtime.ctx.storage.kv.get<StoredGuestRegistration>(
    registrationKey(input.registrationId),
  );
  if (previous) {
    if (
      previous.instanceId !== input.instanceId ||
      previous.matchId !== input.matchId ||
      previous.oldTokenHash !== input.oldTokenHash ||
      previous.newTokenHash !== input.newTokenHash ||
      previous.guestAccountId !== input.guestAccountId
    )
      return { status: "registration_conflict" };
    if (
      previous.state === "cancelled" ||
      (previous.state !== "converted" && previous.claimUntilMs <= Date.now())
    )
      return { status: "expired" };
    return { status: "started", registration: registrationView(runtime, previous) };
  }
  return null;
}

function retainRegistrationClaim(
  runtime: RoomRuntime,
  input: GuestRegistrationInput,
  now: number,
): BeginGuestRegistrationResult | null {
  if (
    input.newTokenHash === input.oldTokenHash ||
    !membershipTokenSchema.safeParse(input.newTokenHash).success
  )
    return { status: "registration_conflict" };
  if (
    [...runtime.ctx.storage.kv.list<StoredGuestRegistration>({ prefix: registrationPrefix })].some(
      ([, record]) => record.state === "pending" && record.newTokenHash === input.newTokenHash,
    )
  )
    return { status: "registration_conflict" };
  // 席を失った後も、初回に検証した本人資格から前局だけを引き継げます。
  const retained = [
    ...runtime.ctx.storage.kv.list<StoredGuestRegistration>({ prefix: registrationPrefix }),
  ]
    .map(([, record]) => record)
    .find(
      (record) =>
        record.instanceId === input.instanceId &&
        record.matchId === input.matchId &&
        record.oldTokenHash === input.oldTokenHash &&
        record.guestAccountId === input.guestAccountId &&
        !record.accountId &&
        (record.holdUntilMs <= now || record.state === "released") &&
        record.claimUntilMs > now,
    );
  if (retained) {
    const record: StoredGuestRegistration = {
      ...retained,
      ...input,
      state: "expired",
      accountId: null,
    };
    runtime.ctx.storage.kv.put(registrationKey(input.registrationId), record);
    return { status: "started", registration: guestRegistrationState(record) };
  }
  return null;
}
