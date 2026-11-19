import type { AuthEnv } from "../../adapters/account/auth";
import { unsealToken } from "../account/authTokens";

export async function revokeProviderToken(
  env: AuthEnv,
  provider: string | null,
  token: string | null,
) {
  if (!token) return;
  token = await unsealToken(env, token);
  let response: Response;
  if (provider === "google")
    response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10000),
    });
  else if (provider === "discord")
    response = await fetch("https://discord.com/api/oauth2/token/revoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${env.DISCORD_CLIENT_ID ?? ""}:${env.DISCORD_CLIENT_SECRET ?? ""}`)}`,
      },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10000),
    });
  else throw new Error("Unsupported provider");
  if (response.ok) return;
  if (response.status === 400) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    if (data?.error === "invalid_token") return;
  }
  throw new Error("Provider revocation failed");
}
