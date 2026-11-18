import type { AuthEnv } from "../accounts/auth";
import { completeGuestLinkCallback } from "../flows/guestRegistration/guestLink";
import { responseCookies } from "../accounts/authCookies";

export async function completeGuestLink(request: Request, response: Response, env: AuthEnv) {
  if (
    new URL(request.url).searchParams.has("error") ||
    response.status >= 400 ||
    !response.headers
      .getSetCookie()
      .some((cookie) => /^(?:__Secure-)?tetraboard-2026\.session_token=.+/.test(cookie))
  )
    return;
  const outcome = await completeGuestLinkCallback(
    request,
    env,
    () => new Request(request.url, { headers: responseCookies(request, response) }),
  );
  if (outcome === "expired") {
    const cookies = response.headers.getSetCookie();
    response.headers.delete("Set-Cookie");
    for (const cookie of cookies)
      if (!/^(?:__Secure-)?tetraboard-2026\.session_token=/.test(cookie))
        response.headers.append("Set-Cookie", cookie);
    response.headers.set("Location", "/login?error=guest_room_link_expired");
  } else if (outcome === "confirm") {
    response.headers.set("Location", "/account?guestMerge=1");
  }
}
