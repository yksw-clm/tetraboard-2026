import { betterAuth } from "better-auth";
import type { AccountProfile } from "@tetraboard/protocol";

export type AuthEnv = Env & {
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};
export function createAuth(env: AuthEnv) {
  const local = new URL(env.APP_ORIGIN).protocol === "http:";
  const secret =
    env.BETTER_AUTH_SECRET ??
    (local ? "tetraboard-local-only-secret-at-least-32-characters" : undefined);
  if (!secret) throw new Error("Authentication is not configured");
  return betterAuth({
    database: env.APP_DB,
    baseURL: env.APP_ORIGIN,
    basePath: "/api/auth",
    secret,
    trustedOrigins: [env.APP_ORIGIN],
    onAPIError: { errorURL: `${env.APP_ORIGIN}/login?error=oauth` },
    advanced: { useSecureCookies: !local, cookiePrefix: "tetraboard-2026" },
    rateLimit: { enabled: !local, storage: "database" },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID ?? "",
        clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
      },
    },
    account: {
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
      user: { create: { before: async (user) => ({ data: { ...user, name: "", image: null } }) } },
    },
  });
}
export async function accountIdentity(request: Request, env: AuthEnv) {
  if (!request.headers.get("cookie")) return null;
  const session = await createAuth(env).api.getSession({ headers: request.headers });
  if (!session) return null;
  // CookieキャッシュやOAuthの再ログインによって古いプロフィールを使わないようにします。
  return env.APP_DB.prepare(
    'SELECT id, name, username, image, profileCompleted, avatarKey FROM "user" WHERE id = ? AND COALESCE(isAnonymous, 0) = 0',
  )
    .bind(session.user.id)
    .first<StoredProfile>();
}
export type StoredProfile = {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
  profileCompleted: number;
  avatarKey: string | null;
};
export function publicProfile(user: StoredProfile): AccountProfile {
  return {
    name: user.name,
    username: user.username,
    avatarUrl: user.image,
    profileCompleted: Boolean(user.profileCompleted),
  };
}
