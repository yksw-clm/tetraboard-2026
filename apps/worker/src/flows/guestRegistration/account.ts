import { registrationCredentialSchema, type RegistrationStatus } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountSessionIdentity, type AuthEnv } from "../../accounts/auth";
import { digest } from "../../crypto";
import { responseCookies } from "../../accounts/authCookies";
import { readMatchClaimState } from "../matchSave/claims";
import { D1Registrations } from "../../adapters/account/registrations";
import {
  RegistrationError,
  registrationWithSecret,
  assertRegistrationAccount as assertAccount,
  assertRegistrationSetup,
  getRegistrationStatus,
  prepareRegistrationOAuth as prepareOAuth,
  completeRegistrationOAuth as completeOAuth,
  rememberRegistrationOAuth as rememberOAuth,
  requireRegistrationConsent as requireConsent,
  type RegistrationFlow,
} from "@tetraboard/context-account";
export { RegistrationError, type RegistrationFlow } from "@tetraboard/context-account";
export const readRegistrationFlow = (db: D1Database, id: string) =>
  new D1Registrations(db).read(id);
export const guestRoomLinkComplete = (db: D1Database, flow: RegistrationFlow) =>
  new D1Registrations(db).guestRoomLinkComplete(flow);
export async function registrationWithCredential(env: AuthEnv, credential: unknown) {
  const parsed = registrationCredentialSchema.safeParse(credential);
  if (!parsed.success)
    throw new RegistrationError("invalid_request", 400, "登録情報が正しくありません。");
  return registrationWithSecret(new D1Registrations(env.APP_DB), parsed.data.registrationId, () =>
    digest(parsed.data.secret),
  );
}
export async function registrationFromRequest(request: Request, env: AuthEnv, id: string) {
  const authorization = request.headers.get("Authorization");
  return registrationWithCredential(env, {
    registrationId: id,
    secret: authorization?.startsWith("Bearer ") ? authorization.slice(7) : null,
  });
}
export async function assertRegistrationAccount(
  request: Request,
  env: AuthEnv,
  flow: RegistrationFlow,
  requireProfile: boolean,
) {
  const identity = await accountSessionIdentity(request, env);
  return assertAccount(identity, flow, requireProfile);
}
export async function validateRegistrationSetup(request: Request, env: AuthEnv) {
  const id = request.headers.get("X-Registration-Id");
  const secret = request.headers.get("X-Registration-Secret");
  if (id === null && secret === null) return;
  const flow = await registrationWithCredential(env, { registrationId: id, secret });
  assertRegistrationSetup(flow, Date.now());
  await assertRegistrationAccount(request, env, flow, false);
  return flow;
}
export async function registrationStatus(
  request: Request,
  env: AuthEnv,
  flow: RegistrationFlow,
): Promise<RegistrationStatus> {
  return getRegistrationStatus(flow, {
    identity: () => accountSessionIdentity(request, env),
    matchState: async () =>
      flow.guest_account_id
        ? (await guestRoomLinkComplete(env.APP_DB, flow))
          ? "applied"
          : null
        : flow.account_id
          ? readMatchClaimState(env.APP_DB, flow.match_id, flow.player_id!, flow.account_id)
          : null,
    roomState: () => env.GAME_ROOM.getByName(flow.room_id).getGuestRegistration(flow.id),
    now: Date.now,
  });
}

export async function prepareRegistrationOAuth(env: AuthEnv, credential: unknown) {
  const parsed = registrationCredentialSchema.safeParse(credential);
  if (!parsed.success)
    throw new RegistrationError("invalid_request", 400, "登録情報が正しくありません。");
  return prepareOAuth(
    new D1Registrations(env.APP_DB),
    parsed.data.registrationId,
    () => digest(parsed.data.secret),
    Date.now,
  );
}
export const rememberRegistrationOAuth = (
  env: AuthEnv,
  flow: RegistrationFlow,
  state: string,
  provider: string,
) => rememberOAuth(new D1Registrations(env.APP_DB), flow, state, provider, Date.now());
export async function completeRegistrationOAuth(
  request: Request,
  response: Response,
  env: AuthEnv,
) {
  const state = new URL(request.url).searchParams.get("state");
  if (
    !state ||
    response.status >= 400 ||
    !response.headers
      .getSetCookie()
      .some(
        (v) =>
          /^(?:__Secure-)?tetraboard-2026\.session_token=/.test(v) && !/session_token=;/.test(v),
      )
  )
    return;
  await completeOAuth(new D1Registrations(env.APP_DB), state, {
    now: Date.now,
    acceptProvider: (provider) => new URL(request.url).pathname.endsWith(`/callback/${provider}`),
    identity: () =>
      accountSessionIdentity(
        new Request(request.url, { headers: responseCookies(request, response) }),
        env,
      ),
  });
}

export const requireRegistrationConsent = (db: D1Database, accountId: string) =>
  requireConsent(new D1Registrations(db), accountId, legalVersion);
