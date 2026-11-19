import { verifyDeletionReauthentication, type DeletionProvider } from "@tetraboard/context-privacy";
import { createAuth, type AuthEnv } from "../../adapters/account/auth";
import { responseCookies } from "../../adapters/account/authCookies";
import { challengeCookie, cookieValue } from "./deletionCookies";
import { D1DeletionConfirmation } from "./deletionConfirmation";

export async function startDeletionAuthentication(
  request: Request,
  env: AuthEnv,
  provider: DeletionProvider,
) {
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  return createAuth(env).handler(
    new Request(`${env.APP_ORIGIN}/api/auth/sign-in/social`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider,
        callbackURL: "/account/deletion",
        newUserCallbackURL: "/account/deletion",
        errorCallbackURL: "/account/deletion",
        additionalParams:
          provider === "google"
            ? { prompt: "select_account", max_age: "0" }
            : { prompt: "consent" },
      }),
    }),
  );
}

export async function completeReauthentication(request: Request, response: Response, env: AuthEnv) {
  if (
    response.status >= 400 ||
    !response.headers
      .getSetCookie()
      .some((value) => /^(?:__Secure-)?tetraboard-2026\.session_token=[^;]/.test(value))
  )
    return;
  const challengeId = cookieValue(request, challengeCookie);
  if (!challengeId) return;
  const url = new URL(request.url);
  await verifyDeletionReauthentication(
    new D1DeletionConfirmation(env.APP_DB),
    { challengeId, state: url.searchParams.get("state"), pathname: url.pathname },
    async () => {
      const session = await createAuth(env).api.getSession({
        headers: responseCookies(request, response),
      });
      return (
        session && {
          accountId: session.user.id,
          id: session.session.id,
          createdAtMs: new Date(session.session.createdAt).getTime(),
        }
      );
    },
    Date.now,
  );
}
