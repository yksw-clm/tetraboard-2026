import { symmetricDecrypt } from "better-auth/crypto";
import type { AuthEnv } from "../accounts/auth";
export function authSecret(env: AuthEnv) {
  const secret =
    env.BETTER_AUTH_SECRET ??
    (new URL(env.APP_ORIGIN).protocol === "http:"
      ? "tetraboard-local-only-secret-at-least-32-characters"
      : undefined);
  if (!secret) throw new Error("Authentication is not configured");
  return secret;
}
export async function unsealToken(env: AuthEnv, token: string) {
  return symmetricDecrypt({ key: authSecret(env), data: token });
}
