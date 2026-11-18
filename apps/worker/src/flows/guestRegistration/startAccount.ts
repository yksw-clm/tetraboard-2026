import {
  startRegistration,
  recordRegistrationStart,
  RegistrationError,
} from "@tetraboard/context-account";
import type { StartRegistration } from "@tetraboard/protocol";
import { accountIdentity } from "../../accounts/auth";
import { digest } from "../../privacy/deletion";
import { D1RegistrationWrites } from "../../adapters/account/registrationWrites";
import { registrationStatus } from "./account";
export async function beginAccountRegistration(
  request: Request,
  env: Env,
  roomId: string,
  data: StartRegistration,
  token: string,
) {
  const guest = data.linkGuest ? await accountIdentity(request, env) : null;
  if (data.linkGuest && !guest?.isAnonymous)
    throw new RegistrationError("unauthorized", 401, "ゲスト本人を確認できません。");
  const guestAccountId = guest?.id ?? null;
  const secretHash = await digest(data.secret);
  const oldTokenHash = await digest(token);
  const store = new D1RegistrationWrites(env.APP_DB);
  const flow = await startRegistration(store, {
    ...data,
    secretHash,
    roomId,
    oldTokenHash,
    guestAccountId,
    now: Date.now(),
  });
  const result = await env.GAME_ROOM.getByName(roomId).beginGuestRegistration({
    registrationId: flow.id,
    instanceId: flow.instance_id,
    matchId: flow.match_id,
    oldTokenHash,
    newTokenHash: flow.new_token_hash,
    ...(guestAccountId ? { guestAccountId } : {}),
  });
  if (result.status !== "started") {
    // 認証を拒否した開始要求は残しません。RPCの結果不明時は同じIDで再試行できます。
    await store.removeUnprepared(flow.id, secretHash);
    throw new RegistrationError(
      result.status,
      result.status === "unauthorized"
        ? 401
        : result.status === "not_found"
          ? 404
          : result.status === "expired"
            ? 410
            : 409,
      "この結果から登録を始められません。ルームの状態を確認してください。",
    );
  }
  const registered = result.registration;
  const current = await recordRegistrationStart(store, flow.id, registered);
  if (current.cancelled_at_ms !== null) {
    await env.GAME_ROOM.getByName(roomId).cancelGuestRegistration(flow.id);
    throw new RegistrationError("cancelled", 409, "この登録手続きは中止されています。");
  }
  return registrationStatus(request, env, current);
}
