import {
  guestIdentity,
  hasGuestSessionCookie,
  suspendGuestSession,
} from "../../routes/guestSession";
import { authSecret } from "./authTokens";
import { isDeleted } from "../privacy/identity";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { D1AccountProfiles } from "./profiles";
export type { StoredProfile } from "@tetraboard/context-account";
export {
  publicProfile,
  accountAvatarUrl,
  profileAvatarUrl,
  avatarKeyPattern,
} from "./profilePolicy";

export type AuthEnv = Env & {
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
};

// 認証する経路だけでCookieを集め、最終HTTP応答にまとめて引き継ぎます。
// Requestをキーにすることで、並行リクエストや別アカウントのCookieを混ぜません。
const sessionCookies = new WeakMap<Request, string[]>();
export function appendSessionCookie(request: Request, cookie: string) {
  sessionCookies.get(request)?.push(cookie);
}
export async function withAccountSessionCookies(
  request: Request,
  respond: () => Promise<Response>,
): Promise<Response> {
  const cookies: string[] = [];
  sessionCookies.set(request, cookies);
  try {
    const response = await respond();
    if (!cookies.length) return response;
    // fetchで取得した変更不可のヘッダーにも対応し、本文・status・WebSocketを保持します。
    const updated = new Response(response.body, response);
    const explicit = new Set(response.headers.getSetCookie().map((v) => v.split("=")[0]));
    for (const cookie of cookies)
      if (!explicit.has(cookie.split("=")[0])) updated.headers.append("Set-Cookie", cookie);
    return updated;
  } finally {
    sessionCookies.delete(request);
  }
}

function socialProviders(env: AuthEnv) {
  return {
    discord: {
      clientId: env.DISCORD_CLIENT_ID ?? "",
      clientSecret: env.DISCORD_CLIENT_SECRET ?? "",
      disableDefaultScope: true,
      scope: ["identify", "email"],
    },
    google: {
      accessType: "online",
      clientId: env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
      disableDefaultScope: true,
      scope: ["openid", "email", "profile"],
    },
  } satisfies BetterAuthOptions["socialProviders"];
}

function userOptions() {
  return {
    additionalFields: {
      username: { type: "string", required: false, input: false },
      profileCompleted: { type: "boolean", required: false, defaultValue: false, input: false },
      avatarKey: { type: "string", required: false, input: false },
      avatarPresetId: { type: "string", required: false, input: false },
      profileMessage: { type: "string", required: false, input: false },
      favoriteGames: { type: "string", required: false, input: false },
    },
  } satisfies BetterAuthOptions["user"];
}

export function createAuth(env: AuthEnv, createdAccounts?: Set<string>) {
  const local = new URL(env.APP_ORIGIN).protocol === "http:";
  const secret = authSecret(env);
  return betterAuth({
    logger: { disabled: true },
    database: env.APP_DB,
    baseURL: env.APP_ORIGIN,
    basePath: "/api/auth",
    secret,
    trustedOrigins: [env.APP_ORIGIN],
    onAPIError: { errorURL: `${env.APP_ORIGIN}/login` },
    advanced: {
      useSecureCookies: !local,
      cookiePrefix: "tetraboard-2026",
      // リクエストごとの全表走査を避け、authDatabaseReads.test.tsでmigrationとの整合性を検証します。
      database: { validateSchema: false },
    },
    rateLimit: { enabled: !local, storage: "database" },
    socialProviders: socialProviders(env),
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: false,
        trustedProviders: [],
        requireLocalEmailVerified: true,
        updateUserInfoOnLink: false,
      },
    },
    user: userOptions(),
    databaseHooks: {
      session: {
        create: {
          before: async (session) =>
            (await isDeleted(env.APP_DB, session.userId)) ? false : undefined,
        },
      },
      account: {
        encryptOAuthTokens: true,
        create: {
          before: async (account) => ({ data: { ...account, refreshToken: null, idToken: null } }),
        },
        update: {
          before: async (account) => ({ data: { ...account, refreshToken: null, idToken: null } }),
        },
      },
      user: {
        create: {
          after: async (user) => {
            createdAccounts?.add(user.id);
          },
          before: async (user) => ({
            data: { ...user, name: "", image: null },
          }),
        },
      },
    },
  });
}
function hasAccountSessionCookie(request: Request) {
  return /(?:^|;\s*)(?:__Secure-)?tetraboard-2026\.session_token=/.test(
    request.headers.get("Cookie") ?? "",
  );
}
export function hasIdentityCookie(request: Request) {
  return hasAccountSessionCookie(request) || hasGuestSessionCookie(request);
}
export async function accountSessionIdentity(request: Request, env: AuthEnv) {
  if (!hasAccountSessionCookie(request)) return null;
  const { response: session, headers } = await createAuth(env).api.getSession({
    headers: request.headers,
    returnHeaders: true,
  });
  sessionCookies.get(request)?.push(...headers.getSetCookie());
  if (!session) return null;
  // CookieキャッシュやOAuthの再ログインによって古いプロフィールを使わないようにします。
  const user = await new D1AccountProfiles(env.APP_DB).sessionProfile(session.user.id);
  return user ? { user, sessionId: session.session.id } : null;
}
export async function accountIdentity(request: Request, env: AuthEnv) {
  const identity = await accountSessionIdentity(request, env);
  if (identity) {
    await suspendGuestSession(request, env);
    return identity.user;
  }
  // 登録セッションの失効時に、別のゲストへ自動で切り替えません。
  if (hasAccountSessionCookie(request)) return null;
  return guestIdentity(request, env);
}

export async function registeredIdentity(request: Request, env: AuthEnv) {
  return (await accountSessionIdentity(request, env))?.user ?? null;
}
