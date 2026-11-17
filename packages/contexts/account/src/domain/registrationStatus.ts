import type { RegistrationStatus } from "@tetraboard/protocol";
import {
  RegistrationError,
  type RegistrationFlow,
  type RegistrationIdentity,
} from "./registration";
export function assertRegistrationStatus(
  flow: RegistrationFlow,
): asserts flow is RegistrationFlow & { player_id: string } {
  if (!flow.player_id && flow.cancelled_at_ms !== null)
    throw new RegistrationError("cancelled", 409, "この登録手続きは中止されています。");
  if (!flow.player_id)
    throw new RegistrationError(
      "preparing",
      503,
      "登録の準備を確認しています。もう一度お試しください。",
    );
}
export function registrationStatus(
  flow: RegistrationFlow & { player_id: string },
  identity: RegistrationIdentity | null,
  matchState: string | null,
  state: { state: string } | null,
  now: () => number,
): RegistrationStatus {
  let seat: RegistrationStatus["seat"] = flow.seat_state;
  if (state) {
    seat =
      state.state === "converted"
        ? "complete"
        : state.state === "pending"
          ? flow.seat_state === "conflict"
            ? "conflict"
            : "held"
          : state.state === "cancelled"
            ? "cancelled"
            : state.state === "expired"
              ? "expired"
              : "unavailable";
  } else if (seat !== "complete") {
    seat =
      flow.cancelled_at_ms !== null
        ? "cancelled"
        : flow.hold_until_ms <= now()
          ? "expired"
          : "unavailable";
  }
  return {
    registrationId: flow.id,
    roomId: flow.room_id,
    instanceId: flow.instance_id,
    matchId: flow.match_id,
    playerId: flow.player_id,
    holdUntilMs: flow.hold_until_ms,
    claimUntilMs: flow.claim_until_ms,
    identity: !flow.account_id
      ? "unverified"
      : !identity || flow.account_id !== identity.user.id || flow.session_id !== identity.sessionId
        ? "mismatch"
        : identity.user.profileCompleted
          ? "ready"
          : "profile_required",
    record:
      matchState === "applied"
        ? "complete"
        : matchState === "retired"
          ? "retired"
          : matchState === "rejected"
            ? "conflict"
            : matchState === "pending"
              ? "pending"
              : flow.claim_until_ms <= now()
                ? "expired"
                : "unclaimed",
    seat,
  };
}
