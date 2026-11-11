import { recordAccountUsage } from "./usage";
import { createAuth, type AuthEnv } from "./auth";
import { responseCookies } from "../privacy/deletion";

/** セッションの期限更新ではなく、OAuth成功時にだけ呼びます。 */
export async function recordLoginUsage(request: Request, response: Response, env: AuthEnv) {
  if (
    response.status >= 400 ||
    !response.headers
      .getSetCookie()
      .some((value) => /^(?:__Secure-)?tetraboard-2026\.session_token=[^;]/.test(value))
  )
    return;
  try {
    // 期限切れchallengeが毎時処理で削除済みでも、固定の戻り先で再認証を識別できます。
    const destination = new URL(response.headers.get("Location") ?? "/", env.APP_ORIGIN);
    if (destination.pathname === "/account/deletion" || destination.searchParams.has("error"))
      return;
    const state = new URL(request.url).searchParams.get("state");
    // 再認証の開始に発行したstateは、通常ログインの最新値へ混ぜません。
    if (
      state &&
      (await env.APP_DB.prepare("SELECT 1 FROM deletion_challenges WHERE oauth_state=?")
        .bind(state)
        .first())
    )
      return;
    const session = await createAuth(env).api.getSession({
      headers: responseCookies(request, response),
    });
    if (!session) return;
    const atMs = new Date(session.session.createdAt).getTime();
    await env.APP_DB.prepare(`INSERT INTO account_usage(account_id,last_login_at_ms)
      SELECT id,? FROM user WHERE id=? AND COALESCE(isAnonymous,0)=0
        AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=user.id)
      ON CONFLICT(account_id) DO UPDATE SET last_login_at_ms=excluded.last_login_at_ms
        WHERE last_login_at_ms IS NULL OR last_login_at_ms<excluded.last_login_at_ms`)
      .bind(atMs, session.user.id)
      .run();
    await recordAccountUsage(env.APP_DB, session.user.id, atMs);
  } catch {
    console.warn("Login usage save failed");
  }
}
