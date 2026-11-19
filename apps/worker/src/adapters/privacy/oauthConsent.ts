import { completeOAuthLegalConsent } from "@tetraboard/context-privacy";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountIdentity, type AuthEnv } from "../../adapters/account/auth";
import { responseCookies } from "../../adapters/account/authCookies";
import { D1LegalConsent } from "./consent";

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
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!state) return;
  await completeOAuthLegalConsent(
    new D1LegalConsent(env.APP_DB),
    { state, pathname: url.pathname },
    legalVersion,
    async () => {
      const user = await accountIdentity(
        new Request(request.url, { headers: responseCookies(request, response) }),
        env,
      );
      return user?.id ?? null;
    },
    Date.now,
  );
}
