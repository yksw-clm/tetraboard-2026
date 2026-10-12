import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
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
export const encryptedToken = (token: string) =>
  token.startsWith("$ba$") || (token.length % 2 === 0 && /^[0-9a-f]+$/i.test(token));
export async function unsealToken(env: AuthEnv, token: string) {
  return encryptedToken(token) ? symmetricDecrypt({ key: authSecret(env), data: token }) : token;
}
// 初回の毎時処理から旧版の平文を暗号化します。失敗しても元行を壊さず再実行できます。
export async function migrateOAuthTokens(env: AuthEnv) {
  const rows = await env.APP_DB.prepare(
    "SELECT id,accessToken FROM account WHERE accessToken IS NOT NULL AND accessToken NOT LIKE '$ba$%' AND (accessToken GLOB '*[^0-9a-fA-F]*' OR length(accessToken)%2 != 0) LIMIT 100",
  ).all<{ id: string; accessToken: string }>();
  for (const row of rows.results) {
    if (encryptedToken(row.accessToken)) continue;
    const sealed = await symmetricEncrypt({ key: authSecret(env), data: row.accessToken });
    await env.APP_DB.prepare("UPDATE account SET accessToken=? WHERE id=? AND accessToken=?")
      .bind(sealed, row.id, row.accessToken)
      .run();
  }
}
