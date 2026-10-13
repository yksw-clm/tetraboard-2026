import type { RoomMembership } from "@tetraboard/protocol";
import type { AccountAdmission } from "../accounts/roomAccounts";

export const registrationHoldMs = 10 * 60_000;
export const registrationClaimMs = 60 * 60_000;
export const registrationPrefix = "guest-registration:";
export const registrationKey = (id: string) => registrationPrefix + id;
export const cancelledRegistrationKey = (id: string) => `guest-registration-cancelled:${id}`;
export const registrationTargetKey = (matchId: string, playerId: string) =>
  `guest-registration-target:${matchId}:${playerId}`;
export const activeRegistrationKey = (playerId: string) => `guest-registration-active:${playerId}`;

export type GuestRegistrationInput = {
  registrationId: string;
  instanceId: string;
  matchId: string;
  oldTokenHash: string;
  newTokenHash: string;
};
export type GuestRegistrationState = {
  registrationId: string;
  instanceId: string;
  matchId: string;
  playerId: string;
  startedAtMs: number;
  holdUntilMs: number;
  claimUntilMs: number;
  state: "pending" | "cancelled" | "expired" | "converted" | "released";
  accountId: string | null;
};
export type StoredGuestRegistration = GuestRegistrationState & {
  oldTokenHash: string;
  newTokenHash: string;
  originalAccountIds: string[];
  admission?: AccountAdmission;
};
export type BeginGuestRegistrationResult =
  | { status: "started"; registration: GuestRegistrationState }
  | {
      status:
        | "not_found"
        | "room_changed"
        | "room_started"
        | "unauthorized"
        | "not_guest"
        | "invalid_match"
        | "registration_conflict"
        | "expired";
    };
export type CompleteGuestRegistrationResult =
  | { status: "converted"; registration: GuestRegistrationState; membership: RoomMembership }
  | {
      status:
        | "not_found"
        | "expired"
        | "cancelled"
        | "released"
        | "room_changed"
        | "account_reservation_invalid"
        | "account_conflict";
    };

export function guestRegistrationState(record: StoredGuestRegistration): GuestRegistrationState {
  const {
    oldTokenHash: _old,
    newTokenHash: _next,
    originalAccountIds: _accounts,
    admission: _admission,
    ...state
  } = record;
  return state;
}
