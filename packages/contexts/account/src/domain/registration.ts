import type { RegistrationStatus } from "@tetraboard/protocol";
import type { StoredProfile } from "./profile";
export type RegistrationFlow = {
  id: string;
  secret_hash: string;
  room_id: string;
  instance_id: string;
  match_id: string;
  player_id: string | null;
  guest_account_id: string | null;
  old_token_hash: string;
  new_token_hash: string;
  created_at_ms: number;
  hold_until_ms: number;
  claim_until_ms: number;
  account_id: string | null;
  session_id: string | null;
  cancelled_at_ms: number | null;
  record_accepted_at_ms: number | null;
  seat_state: RegistrationStatus["seat"];
};

export class RegistrationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 503,
    message: string,
  ) {
    super(message);
  }
}

export type RegistrationIdentity = { user: StoredProfile; sessionId: string };
export function assertRegistrationAccount(
  identity: RegistrationIdentity | null,
  flow: RegistrationFlow,
  requireProfile: boolean,
) {
  if (!identity) throw new RegistrationError("unauthorized", 401, "ログインしてください。");
  if (flow.cancelled_at_ms !== null)
    throw new RegistrationError("cancelled", 409, "この登録手続きは中止されています。");
  if (flow.account_id !== identity.user.id || flow.session_id !== identity.sessionId)
    throw new RegistrationError(
      "account_mismatch",
      409,
      "登録時のログイン状態に戻すか、中止して元の結果からやり直してください。",
    );
  if (requireProfile && !identity.user.profileCompleted)
    throw new RegistrationError("profile_required", 403, "プロフィールを作成してください。");
  return identity;
}
export function assertRegistrationOAuth(flow: RegistrationFlow, now: number) {
  if (!flow.player_id || flow.cancelled_at_ms !== null || flow.claim_until_ms <= now)
    throw new RegistrationError("expired", 410, "登録手続きの期限が過ぎたか、中止されています。");
  if (flow.account_id !== null || flow.session_id !== null)
    throw new RegistrationError(
      "account_mismatch",
      409,
      "登録時のログイン状態に戻すか、中止して元の結果からやり直してください。",
    );
  return flow;
}

export function assertRegistrationSetup(flow: RegistrationFlow, now: number) {
  if (flow.claim_until_ms <= now)
    throw new RegistrationError("expired", 410, "登録手続きの期限が過ぎました。");
}
