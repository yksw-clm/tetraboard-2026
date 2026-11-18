import type { RegistrationFlow } from "./registration";

export type GuestMergeFlow = {
  state: string;
  guest_id: string;
  target_id: string;
  target_session_id: string;
  name: string;
  is_new_target: number;
  room_registration_id?: string | null;
};

export class GuestLinkError extends Error {}

export function assertGuestIdle(busy: boolean) {
  if (busy)
    throw new GuestLinkError(
      "参加中のルームを退室し、大会・ランダムマッチの待機を取り消してから連携してください。",
    );
}

export function assertGuestMergeRoom(conflict: boolean) {
  if (conflict) throw new GuestLinkError("同じ対局で参加した複数の席の記録は統合できません。");
}

export function canUseHeldRegistration(
  registration: RegistrationFlow | null,
  guestId: string,
): registration is RegistrationFlow {
  return registration?.guest_account_id === guestId && registration.cancelled_at_ms === null;
}

export function guestPromotionCredentials(hash: string | null, target: { email: string } | null) {
  if (!hash || !target) throw new GuestLinkError("連携の本人確認をやり直してください。");
  return { hash, email: target.email };
}

export function isNewGuestLinkTarget(
  profileCompleted: number,
  target: { createdAt: string } | null,
  startedAt: number,
) {
  return !profileCompleted && target !== null && Date.parse(target.createdAt) >= startedAt;
}
