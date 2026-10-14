import { registrationCredentialSchema, type RegistrationStatus } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountSessionIdentity, type AuthEnv } from "./auth";
import { digest, responseCookies } from "../privacy/deletion";
import { readMatchClaimState } from "./matchClaims";

export type RegistrationFlow = {
  id: string;
  secret_hash: string;
  room_id: string;
  instance_id: string;
  match_id: string;
  player_id: string | null;
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

export async function readRegistrationFlow(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM registration_flows WHERE id=?")
    .bind(id)
    .first<RegistrationFlow>();
}

export async function registrationWithCredential(env: AuthEnv, credential: unknown) {
  const parsed = registrationCredentialSchema.safeParse(credential);
  if (!parsed.success)
    throw new RegistrationError("invalid_request", 400, "登録情報が正しくありません。");
  const flow = await readRegistrationFlow(env.APP_DB, parsed.data.registrationId);
  if (!flow || flow.secret_hash !== (await digest(parsed.data.secret)))
    throw new RegistrationError("unauthorized", 401, "登録手続きの資格を確認できません。");
  return flow;
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

export async function validateRegistrationSetup(request: Request, env: AuthEnv) {
  const id = request.headers.get("X-Registration-Id");
  const secret = request.headers.get("X-Registration-Secret");
  if (id === null && secret === null) return;
  const flow = await registrationWithCredential(env, { registrationId: id, secret });
  if (flow.claim_until_ms <= Date.now())
    throw new RegistrationError("expired", 410, "登録手続きの期限が過ぎました。");
  await assertRegistrationAccount(request, env, flow, false);
  return flow;
}

export async function registrationStatus(
  request: Request,
  env: AuthEnv,
  flow: RegistrationFlow,
): Promise<RegistrationStatus> {
  if (!flow.player_id && flow.cancelled_at_ms !== null)
    throw new RegistrationError("cancelled", 409, "この登録手続きは中止されています。");
  if (!flow.player_id)
    throw new RegistrationError(
      "preparing",
      503,
      "登録の準備を確認しています。もう一度お試しください。",
    );
  const identity = await accountSessionIdentity(request, env);
  const matchState = flow.account_id
    ? await readMatchClaimState(env.APP_DB, flow.match_id, flow.player_id, flow.account_id)
    : null;
  const state = await env.GAME_ROOM.getByName(flow.room_id).getGuestRegistration(flow.id);
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
        : flow.hold_until_ms <= Date.now()
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
              : flow.claim_until_ms <= Date.now()
                ? "expired"
                : "unclaimed",
    seat,
  };
}

export async function prepareRegistrationOAuth(env: AuthEnv, credential: unknown) {
  const flow = await registrationWithCredential(env, credential);
  if (!flow.player_id || flow.cancelled_at_ms !== null || flow.claim_until_ms <= Date.now())
    throw new RegistrationError("expired", 410, "登録手続きの期限が過ぎたか、中止されています。");
  if (flow.account_id !== null || flow.session_id !== null)
    throw new RegistrationError(
      "account_mismatch",
      409,
      "登録時のログイン状態に戻すか、中止して元の結果からやり直してください。",
    );
  return flow;
}

export async function rememberRegistrationOAuth(
  env: AuthEnv,
  flow: RegistrationFlow,
  state: string,
  provider: string,
) {
  const now = Date.now();
  const results = await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM registration_oauth_states WHERE registration_id=?").bind(
      flow.id,
    ),
    env.APP_DB.prepare(`INSERT INTO registration_oauth_states (state,registration_id,provider,expires_at_ms)
      SELECT ?,id,?,? FROM registration_flows WHERE id=? AND cancelled_at_ms IS NULL AND claim_until_ms>?
        AND account_id IS NULL AND session_id IS NULL RETURNING state`).bind(
      state,
      provider,
      Math.min(flow.claim_until_ms, now + 600_000),
      flow.id,
      now,
    ),
  ]);
  if (!results[1].results.length)
    throw new RegistrationError(
      "conflict",
      409,
      "登録手続きの状態が変わりました。元の結果から確認してください。",
    );
}

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
  const pending =
    await env.APP_DB.prepare(`SELECT registration_id,provider FROM registration_oauth_states
    WHERE state=? AND expires_at_ms>?`)
      .bind(state, Date.now())
      .first<{ registration_id: string; provider: string }>();
  if (!pending || !new URL(request.url).pathname.endsWith(`/callback/${pending.provider}`)) return;
  const identity = await accountSessionIdentity(
    new Request(request.url, { headers: responseCookies(request, response) }),
    env,
  );
  if (!identity) return;
  await env.APP_DB.batch([
    env.APP_DB.prepare(`UPDATE registration_flows SET account_id=?,session_id=? WHERE id=?
      AND cancelled_at_ms IS NULL AND claim_until_ms>? AND account_id IS NULL AND session_id IS NULL
      AND EXISTS (SELECT 1 FROM registration_oauth_states WHERE state=? AND registration_id=registration_flows.id AND provider=? AND expires_at_ms>?)
      AND NOT EXISTS (SELECT 1 FROM deleted_accounts WHERE id=?)`).bind(
      identity.user.id,
      identity.sessionId,
      pending.registration_id,
      Date.now(),
      state,
      pending.provider,
      Date.now(),
      identity.user.id,
    ),
    env.APP_DB.prepare("DELETE FROM registration_oauth_states WHERE state=?").bind(state),
  ]);
}

export async function requireRegistrationConsent(db: D1Database, accountId: string) {
  const consent = await db
    .prepare("SELECT 1 FROM legal_consents WHERE account_id=? AND version=?")
    .bind(accountId, legalVersion)
    .first();
  if (!consent)
    throw new RegistrationError("consent_required", 403, "利用規約と年齢条件を確認してください。");
}
