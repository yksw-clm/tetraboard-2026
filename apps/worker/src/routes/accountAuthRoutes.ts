import {
  recordRegistrationOAuthStart,
  writeRegistrationCompletionUsage,
  parseRegistrationAnalytics,
} from "../usageEvents/registration";
import { matchmakingQueueKeys, type RegistrationAnalyticsInput } from "@tetraboard/protocol";
import { prepareGuestLink, rememberGuestLink } from "../flows/guestRegistration/guestLink";
import { completeGuestLink } from "./guestLinkOAuth";
import { GuestLinkError } from "@tetraboard/context-account";
import { clearGuestSession } from "../routes/guestSession";
import { completeLegalAuthentication } from "../privacy/oauthConsent";
import { completeReauthentication } from "../privacy/deletion";
import { legalVersion } from "@tetraboard/protocol/privacy";
import {
  completeRegistrationOAuth,
  prepareRegistrationOAuth,
  rememberRegistrationOAuth,
  type RegistrationFlow,
} from "../flows/guestRegistration/account";
import { Hono } from "hono";
import { accountIdentity, createAuth, type AuthEnv, type StoredProfile } from "../accounts/auth";
export const accountAuthRoutes = new Hono<{ Bindings: AuthEnv }>();
const error = (message: string) => ({ message });
accountAuthRoutes.on(["GET", "POST"], "/auth/*", async (c) => {
  const path = new URL(c.req.url).pathname.replace(/^\/api/, "");
  if (
    c.req.method === "GET" &&
    ["/auth/callback/google", "/auth/callback/discord"].includes(path)
  ) {
    const createdAccounts = new Set<string>();
    const response = await createAuth(c.env, createdAccounts).handler(
      new Request(`${c.env.APP_ORIGIN}/api${path}${new URL(c.req.url).search}`, c.req.raw),
    );
    await completeGuestLink(c.req.raw, response, c.env);
    await completeReauthentication(c.req.raw, response, c.env);
    await completeLegalAuthentication(c.req.raw, response, c.env);
    await completeRegistrationOAuth(c.req.raw, response, c.env);
    await writeRegistrationCompletionUsage(c.env, c.req.raw, response, createdAccounts.size > 0);
    return response;
  }
  if (c.req.method !== "POST" || !["/auth/sign-in/social", "/auth/sign-out"].includes(path))
    return c.json(error("見つかりません。"), 404);
  if (c.req.header("Origin") !== c.env.APP_ORIGIN)
    return c.json(error("操作元を確認できません。ページを開き直してください。"), 403);
  if (path === "/auth/sign-out") {
    const user = await accountIdentity(c.req.raw, c.env);
    if (user?.isAnonymous) return c.json(error("ゲストはログアウトできません。"), 403);
    if (user) {
      for (const key of matchmakingQueueKeys)
        await c.env.MATCHMAKING_COORDINATOR.getByName(key).leaveAccount(user.id);
      const tournaments = await c.env.APP_DB.prepare(`SELECT DISTINCT e.tournament_key
        FROM tournament_entries e JOIN tournaments t ON t.key=e.tournament_key
        WHERE e.account_id=? AND t.published=1 AND t.finalized_at_ms IS NULL`)
        .bind(user.id)
        .all<{ tournament_key: string }>();
      // 認証を失効させる前に解除し、別タブの参加確認でも開始できないようにします。
      for (const tournament of tournaments.results)
        await c.env.TOURNAMENT_COORDINATOR.getByName(tournament.tournament_key).cancelForAccount(
          user.id,
        );
    }
  }
  let provider: "google" | "discord" = "google";
  let adminLogin = false;
  let analytics: RegistrationAnalyticsInput | undefined;
  let registration: RegistrationFlow | undefined;
  let guest: StoredProfile | null = null;
  if (path === "/auth/sign-in/social") {
    let input: unknown;
    try {
      const body = await c.req.text();
      input = body ? JSON.parse(body) : {};
    } catch {
      return c.json(error("認証方法の指定が正しくありません。"), 400);
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      return c.json(error("認証方法の指定が正しくありません。"), 400);
    const data = input as Record<string, unknown>;
    if (data.provider !== undefined && data.provider !== "google" && data.provider !== "discord")
      return c.json(error("認証方法の指定が正しくありません。"), 400);
    provider = data.provider === "discord" ? "discord" : "google";
    if (
      data.destination !== "admin" &&
      data.consentVersion !== legalVersion &&
      c.req.header("X-Legal-Consent") !== legalVersion
    )
      return c.json(error("規約と年齢条件を確認してください。"), 403);
    adminLogin = data.destination === "admin";
    analytics = parseRegistrationAnalytics(data.analytics);
    if (data.registration !== undefined) {
      if (adminLogin) return c.json(error("管理画面のログインでは対局を引き継げません。"), 400);
      registration = await prepareRegistrationOAuth(c.env, data.registration);
    }
    if (!adminLogin) guest = await prepareGuestLink(c.req.raw, c.env, registration);
    if (registration?.guest_account_id && !guest)
      throw new GuestLinkError("連携を始めたゲスト本人でお試しください。");
    if (adminLogin && provider !== "google")
      return c.json(error("管理画面にはGoogleでログインしてください。"), 400);
    const configured =
      provider === "google"
        ? c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET
        : c.env.DISCORD_CLIENT_ID && c.env.DISCORD_CLIENT_SECRET;
    if (!configured)
      return c.json(
        error(`${provider === "google" ? "Google" : "Discord"}ログインは準備中です。`),
        503,
      );
  }
  // 許可したプロバイダーだけを使い、遷移先はサーバーで固定します。
  const response = await createAuth(c.env).handler(
    new Request(`${c.env.APP_ORIGIN}/api${path}`, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify(
        path === "/auth/sign-out"
          ? {}
          : {
              provider,
              callbackURL: adminLogin ? "/admin" : "/account",
              newUserCallbackURL: adminLogin ? "/admin" : "/account/setup",
              errorCallbackURL: adminLogin ? "/login?destination=admin" : "/login",
            },
      ),
    }),
  );
  if (path === "/auth/sign-out" && response.ok) await clearGuestSession(c.req.raw, c.env);
  if (path === "/auth/sign-in/social" && !adminLogin && response.ok) {
    const data = (await response.clone().json()) as { url?: string };
    const state = data.url ? new URL(data.url).searchParams.get("state") : null;
    if (state) {
      await c.env.APP_DB.prepare("INSERT INTO oauth_legal_consents VALUES (?,?,?,?,?)")
        .bind(state, provider, legalVersion, Date.now(), Date.now() + 600000)
        .run();
      if (registration) await rememberRegistrationOAuth(c.env, registration, state, provider);
      if (guest)
        await rememberGuestLink(
          c.req.raw,
          c.env,
          guest,
          state,
          provider,
          registration?.guest_account_id ? registration.id : undefined,
        );
      await recordRegistrationOAuthStart(c.req.raw, c.env, analytics);
    }
  }
  return response;
});
