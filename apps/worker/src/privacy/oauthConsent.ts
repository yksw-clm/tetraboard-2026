import { accountIdentity, type AuthEnv } from "../accounts/auth";
import { responseCookies } from "./deletion";
import { consentStatement } from "./consent";
import { legalVersion } from "@tetraboard/protocol/privacy";
export async function completeLegalAuthentication(
  request: Request,
  response: Response,
  env: AuthEnv,
) {
  if (
    response.status >= 400 ||
    !response.headers
      .getSetCookie()
      .some(
        (v) =>
          /^(?:__Secure-)?tetraboard-2026\.session_token=/.test(v) &&
          !/^(?:__Secure-)?tetraboard-2026\.session_token=;/.test(v),
      )
  )
    return;
  const url = new URL(request.url),
    state = url.searchParams.get("state");
  if (!state) return;
  const flow = await env.APP_DB.prepare(
    "SELECT provider,version FROM oauth_legal_consents WHERE state=? AND expires_at_ms>?",
  )
    .bind(state, Date.now())
    .first<{ provider: string; version: string }>();
  if (
    !flow ||
    flow.version !== legalVersion ||
    !url.pathname.endsWith(`/callback/${flow.provider}`)
  )
    return;
  const user = await accountIdentity(
    new Request(request.url, { headers: responseCookies(request, response) }),
    env,
  );
  if (!user) return;
  await env.APP_DB.batch([
    consentStatement(env.APP_DB, user.id),
    env.APP_DB.prepare("DELETE FROM oauth_legal_consents WHERE state=?").bind(state),
  ]);
}
