import { guestIdentity } from "./guestAccounts";
import { authSecret } from "../privacy/tokens";
import { isDeleted } from "../privacy/identity";
import { betterAuth } from "better-auth";
import type { AccountProfile } from "@tetraboard/protocol";

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

export function createAuth(env: AuthEnv) {
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
    advanced: { useSecureCookies: !local, cookiePrefix: "tetraboard-2026" },
    rateLimit: { enabled: !local, storage: "database" },
    socialProviders: {
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
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: false,
        trustedProviders: [],
        requireLocalEmailVerified: true,
        updateUserInfoOnLink: false,
      },
    },
    user: {
      additionalFields: {
        username: { type: "string", required: false, input: false },
        profileCompleted: { type: "boolean", required: false, defaultValue: false, input: false },
        avatarKey: { type: "string", required: false, input: false },
      },
    },
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
          before: async (user) => ({
            data: { ...user, name: "", image: null },
          }),
        },
      },
    },
  });
}
export async function accountSessionIdentity(request: Request, env: AuthEnv) {
  if (!request.headers.get("cookie")) return null;
  const { response: session, headers } = await createAuth(env).api.getSession({
    headers: request.headers,
    returnHeaders: true,
  });
  sessionCookies.get(request)?.push(...headers.getSetCookie());
  if (!session) return null;
  // CookieキャッシュやOAuthの再ログインによって古いプロフィールを使わないようにします。
  const user = await env.APP_DB.prepare(
    'SELECT id, name, username, image, profileCompleted, avatarKey, isTestUser, publicProfileId, isAnonymous, guestNameCustomized FROM "user" WHERE id = ? AND COALESCE(isAnonymous, 0) = 0 AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id = user.id)',
  )
    .bind(session.user.id)
    .first<StoredProfile>();
  return user ? { user, sessionId: session.session.id } : null;
}
export async function accountIdentity(request: Request, env: AuthEnv) {
  const identity = await accountSessionIdentity(request, env);
  if (identity) return identity.user;
  // 登録セッションの失効時に、別のゲストへ自動で切り替えません。
  if (
    /(?:^|;\s*)(?:__Secure-)?tetraboard-2026\.session_token=/.test(
      request.headers.get("Cookie") ?? "",
    )
  )
    return null;
  return guestIdentity(request, env);
}
export type StoredProfile = {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
  profileCompleted: number;
  avatarKey: string | null;
  isTestUser?: number | null;
  publicProfileId?: string | null;
  isAnonymous?: number | null;
  guestNameCustomized?: number | null;
};
export function publicProfile(user: StoredProfile): AccountProfile {
  return {
    profileId: user.publicProfileId ?? null,
    name: user.name,
    username: user.username,
    avatarUrl: profileAvatarUrl(user.avatarKey),
    profileCompleted: Boolean(user.profileCompleted),
    ...(user.isAnonymous
      ? { isGuest: true, nameCustomized: Boolean(user.guestNameCustomized) }
      : {}),
  };
}

export const avatarKeyPattern =
  /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
export function profileAvatarUrl(key: string | null): string | null {
  return key && avatarKeyPattern.test(key) ? `/api/avatars/${key.slice(8, -5)}` : null;
}

export async function registeredIdentity(request: Request, env: AuthEnv) {
  return (await accountSessionIdentity(request, env))?.user ?? null;
}
