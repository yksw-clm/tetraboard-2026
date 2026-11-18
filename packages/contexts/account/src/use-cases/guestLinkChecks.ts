import { assertGuestIdle, canUseHeldRegistration } from "../domain/guestLink";
import type { RegistrationFlow } from "../domain/registration";

export interface GuestLinkChecks {
  guestBusy(id: string): Promise<boolean>;
  readRegistration(id: string): Promise<RegistrationFlow | null>;
  roomRegistration(roomId: string, registrationId: string): Promise<{ state: string } | null>;
  now(): number;
}

export async function requireGuestIdle(checks: Pick<GuestLinkChecks, "guestBusy">, id: string) {
  assertGuestIdle(await checks.guestBusy(id));
}

export async function heldRoomRegistration(
  checks: GuestLinkChecks,
  registrationId: string | null | undefined,
  guestId: string,
) {
  if (!registrationId) return null;
  const registration = await checks.readRegistration(registrationId);
  if (!canUseHeldRegistration(registration, guestId) || registration.hold_until_ms <= checks.now())
    return null;
  const state = await checks.roomRegistration(registration.room_id, registrationId);
  return state?.state === "pending" ? registration : null;
}
