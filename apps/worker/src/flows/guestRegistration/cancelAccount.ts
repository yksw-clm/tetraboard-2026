import { cancelGuestRegistration } from "@tetraboard/context-account";
import { accountSessionIdentity } from "../../accounts/auth";
import { D1RegistrationWrites } from "../../adapters/account/registrationWrites";
import {
  RegistrationError,
  readRegistrationFlow,
  registrationStatus,
  type RegistrationFlow,
} from "./account";
export async function cancelAccountRegistration(
  request: Request,
  env: Env,
  flow: RegistrationFlow,
  signOut: boolean,
  clearCookie: (value: string) => void,
) {
  const store = new D1RegistrationWrites(env.APP_DB);
  if (flow.guest_account_id) {
    // コールバックと競合した場合は、先に確定した操作だけを採用します。
    await cancelGuestRegistration(store, flow.id, Date.now());
  }
  const room = env.GAME_ROOM.getByName(flow.room_id);
  const state = await room.cancelGuestRegistration(flow.id);
  if (state?.state === "converted")
    throw new RegistrationError(
      "already_complete",
      409,
      "この席は登録ユーザーへ切り替わっています。",
    );
  const identity = signOut ? await accountSessionIdentity(request, env) : null;
  const fixed = await store.cancel(flow.id, signOut, Date.now());
  if (
    signOut &&
    identity &&
    fixed &&
    identity.sessionId === fixed.session_id &&
    identity.user.id === fixed.account_id
  ) {
    const secure = new URL(env.APP_ORIGIN).protocol === "https:";
    clearCookie(
      `${secure ? "__Secure-" : ""}tetraboard-2026.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
    );
  }
  // 開始RPCが未確定でも取消は確定できます。本人位置はまだ返せません。
  if (!flow.player_id) return null;
  return registrationStatus(request, env, (await readRegistrationFlow(env.APP_DB, flow.id))!);
}
