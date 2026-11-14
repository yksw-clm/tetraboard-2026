import {
  registrationAnalyticsInputSchema,
  type RegistrationAnalyticsInput,
} from "@tetraboard/protocol";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import { accountIdentity, createAuth, type AuthEnv, type StoredProfile } from "../accounts/auth";
import { responseCookies, digest } from "../privacy/deletion";
import { analyticsVisitor } from "./store";
import {
  registrationUsage,
  writeRegistrationCompletionUsage,
  writeProfileCompletionUsage,
} from "../usageEvents/registration";

function flowStatements(
  db: D1Database,
  input: RegistrationAnalyticsInput,
  visitor: string | null,
  user: StoredProfile | null,
  now: number,
  entry: boolean,
) {
  const account = user?.id ?? null;
  const kind = user ? (user.isAnonymous ? "guest" : "registered") : "unregistered";
  return [
    db
      .prepare(`INSERT INTO analytics_registration_flows(id,created_at_ms,visitor_id,source_account_id,kind,is_test,entry,game,
        session_id,utm_link_id,utm_source,utm_medium,utm_campaign,referrer_class,device)
      SELECT ?,?,?,?,?,?,?,?,s.id,s.utm_link_id,s.utm_source,s.utm_medium,s.utm_campaign,s.referrer_class,s.device
      FROM (SELECT 1) LEFT JOIN analytics_sessions s ON s.id=(SELECT id FROM analytics_sessions
        WHERE visitor_id=? AND started_at_ms<=? AND last_activity_ms>? AND started_at_ms>? ORDER BY started_at_ms DESC,id LIMIT 1)
      WHERE NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?) ON CONFLICT(id) DO NOTHING`)
      .bind(
        input.id,
        now,
        visitor,
        account,
        kind,
        Number(Boolean(user?.isTestUser)),
        input.entry,
        input.game ?? "all",
        visitor,
        now,
        now - 1800000,
        now - analyticsRetentionMs,
        account,
      ),
    ...(entry
      ? [
          db
            .prepare(`INSERT INTO analytics_registration_events
      SELECT id,'entry',? FROM analytics_registration_flows WHERE id=? AND visitor_id IS ? AND source_account_id IS ?
        AND created_at_ms>? ON CONFLICT(flow_id,stage) DO NOTHING`)
            .bind(now, input.id, visitor, account, now - analyticsRetentionMs),
        ]
      : []),
  ];
}

export async function recordRegistrationEntry(
  env: Env,
  input: RegistrationAnalyticsInput,
  visitor: string | null,
  user: StoredProfile | null,
  now = Date.now(),
) {
  const usage = registrationUsage(env, input, visitor);
  usage.identify(input, user);
  usage.write("entry");
  await env.APP_DB.batch(flowStatements(env.APP_DB, input, visitor, user, now, true));
}

/** 計測の障害は認証の開始を妨げず、保存できなかった分を成功と推測しません。 */
export async function rememberRegistrationAnalytics(
  request: Request,
  env: AuthEnv,
  state: string,
  provider: string,
  input?: RegistrationAnalyticsInput,
) {
  const usage = registrationUsage(env, input, analyticsVisitor(request));
  try {
    const now = Date.now(),
      visitor = analyticsVisitor(request),
      user = await accountIdentity(request, env);
    const stateHash = await digest(state);
    let flow = input ?? { id: crypto.randomUUID(), entry: "unknown" as const, game: null };
    usage.identify(flow, user);
    await env.APP_DB.batch(flowStatements(env.APP_DB, flow, visitor, user, now, Boolean(input)));
    const own =
      await env.APP_DB.prepare(`SELECT EXISTS(SELECT 1 FROM analytics_registration_events e WHERE e.flow_id=analytics_registration_flows.id AND e.stage='oauth_success') AS completed FROM analytics_registration_flows WHERE id=?
      AND visitor_id IS ? AND source_account_id IS ? AND created_at_ms>?`)
        .bind(flow.id, visitor, user?.id ?? null, now - analyticsRetentionMs)
        .first<{ completed: number }>();
    if (!own || own.completed) {
      flow = {
        id: crypto.randomUUID(),
        entry: own ? flow.entry : "unknown",
        game: input?.game ?? null,
      };
      usage.identify(flow, user);
      await env.APP_DB.batch(
        flowStatements(env.APP_DB, flow, visitor, user, now, Boolean(own && input)),
      );
    }
    await env.APP_DB.batch([
      env.APP_DB.prepare(`INSERT INTO analytics_registration_attempts SELECT ?,id,?,?,?
        FROM analytics_registration_flows WHERE id=? AND visitor_id IS ? AND source_account_id IS ?
        ON CONFLICT(state_hash) DO NOTHING`).bind(
        stateHash,
        provider,
        now,
        now + 600000,
        flow.id,
        visitor,
        user?.id ?? null,
      ),
      env.APP_DB.prepare(`INSERT INTO analytics_registration_events
        SELECT flow_id,'oauth_start',? FROM analytics_registration_attempts WHERE state_hash=?
        ON CONFLICT(flow_id,stage) DO NOTHING`).bind(now, stateHash),
    ]);
  } catch {
    console.warn("Registration analytics save failed");
  } finally {
    usage.write("oauth_start");
  }
}

/** 作成hookと成功応答を組み合わせ、既存ログインや再送を新規登録へ数えません。 */
export async function completeRegistrationAnalytics(
  request: Request,
  response: Response,
  env: AuthEnv,
  newAccount: boolean,
) {
  const url = new URL(request.url),
    state = url.searchParams.get("state");
  if (
    !state ||
    url.searchParams.has("error") ||
    response.status >= 400 ||
    !response.headers
      .getSetCookie()
      .some((cookie) => /^(?:__Secure-)?tetraboard-2026\.session_token=[^;]/.test(cookie))
  )
    return;
  try {
    const destination = new URL(response.headers.get("Location") ?? "/", env.APP_ORIGIN);
    if (destination.searchParams.has("error") || destination.pathname === "/account/deletion")
      return;
    await writeRegistrationCompletionUsage(env, request, response, newAccount);
    const now = Date.now(),
      db = env.APP_DB;
    const attempt = await db
      .prepare(
        `SELECT flow_id,provider FROM analytics_registration_attempts WHERE state_hash=? AND expires_at_ms>?`,
      )
      .bind(await digest(state), now)
      .first<{ flow_id: string; provider: string }>();
    if (!attempt || !url.pathname.endsWith(`/callback/${attempt.provider}`)) return;
    const session = await createAuth(env).api.getSession({
      headers: responseCookies(request, response),
    });
    if (!session) return;
    const account = session.user.id;
    await db.batch([
      db
        .prepare(`UPDATE analytics_registration_flows SET target_account_id=COALESCE(target_account_id,?),
        is_new_registration=COALESCE(is_new_registration,?),profile_required=COALESCE(profile_required,
          (SELECT NOT COALESCE(profileCompleted,0) FROM user WHERE id=?)),
        is_test=MAX(is_test,COALESCE((SELECT isTestUser FROM user WHERE id=?),0))
        WHERE id=? AND created_at_ms>? AND (target_account_id IS NULL OR target_account_id=?)
          AND EXISTS(SELECT 1 FROM user WHERE id=? AND COALESCE(isAnonymous,0)=0)
          AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?)`)
        .bind(
          account,
          Number(newAccount),
          account,
          account,
          attempt.flow_id,
          now - analyticsRetentionMs,
          account,
          account,
          account,
        ),
      ...[
        ["oauth_success", "1"],
        ["registered", "is_new_registration=1"],
        ["existing_login", "is_new_registration=0"],
        ["profile_required", "profile_required=1"],
      ].map(([stage, condition]) =>
        db
          .prepare(`INSERT INTO analytics_registration_events
        SELECT id,?,? FROM analytics_registration_flows WHERE id=? AND target_account_id=? AND ${condition}
        ON CONFLICT(flow_id,stage) DO NOTHING`)
          .bind(stage, now, attempt.flow_id, account),
      ),
      db
        .prepare("DELETE FROM analytics_registration_attempts WHERE state_hash=?")
        .bind(await digest(state)),
    ]);
  } catch {
    console.warn("Registration analytics save failed");
  }
}

export async function recordProfileCompletion(
  env: Env,
  account: string,
  request: Request,
  now = Date.now(),
) {
  await writeProfileCompletionUsage(env, account, request);
  try {
    await env.APP_DB.prepare(`INSERT INTO analytics_registration_events
      SELECT f.id,'profile_complete',? FROM analytics_registration_flows f
      WHERE f.target_account_id=? AND f.profile_required=1 AND f.created_at_ms>?
        AND EXISTS(SELECT 1 FROM analytics_registration_events e WHERE e.flow_id=f.id AND e.stage='oauth_success')
        AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=?)
      ORDER BY f.created_at_ms DESC,f.id LIMIT 1 ON CONFLICT(flow_id,stage) DO NOTHING`)
      .bind(now, account, now - analyticsRetentionMs, account)
      .run();
  } catch {
    console.warn("Registration analytics save failed");
  }
}

export const parseRegistrationAnalytics = (value: unknown) => {
  const input = registrationAnalyticsInputSchema.safeParse(value);
  return input.success ? input.data : undefined;
};
