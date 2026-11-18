import { createGuestAccount as createAccount, guestLifetimeMs } from "@tetraboard/context-account";
import type { AvatarPresetId } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { identifyGuest } from "../adapters/account/guestIdentity";
import { D1GuestAccounts } from "../adapters/account/guestAccounts";
import { appendSessionCookie, type StoredProfile } from "../accounts/auth";
export { guestLifetimeMs } from "@tetraboard/context-account";
const cookieName = "tetraboard-2026.guest";
function guestSessionToken(request: Request) {
  return request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)tetraboard-2026\.guest=([a-f0-9]{64})(?:;|$)/)?.[1];
}
export function hasGuestSessionCookie(request: Request) {
  return guestSessionToken(request) !== undefined;
}
export async function guestTokenHash(request: Request): Promise<string | null> {
  const token = guestSessionToken(request);
  if (!token) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function guestCookie(token: string, env: Env, maxAge = guestLifetimeMs / 1000) {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(env.APP_ORIGIN).protocol === "https:" ? "; Secure" : ""}`;
}
export async function guestIdentity(request: Request, env: Env): Promise<StoredProfile | null> {
  const hash = await guestTokenHash(request);
  if (!hash) return null;
  const user = await identifyGuest(env.APP_DB, hash, Date.now(), guestLifetimeMs);
  if (!user) return null;
  const token = request.headers
    .get("Cookie")!
    .match(/(?:^|;\s*)tetraboard-2026\.guest=([a-f0-9]{64})/)![1]!;
  appendSessionCookie(request, guestCookie(token, env));
  return user;
}
export async function createGuestAccount(
  request: Request,
  env: Env,
  name?: string,
  avatarPresetId?: AvatarPresetId,
): Promise<StoredProfile> {
  if (
    request.headers.get("Origin") !== env.APP_ORIGIN ||
    request.headers.get("X-Legal-Consent") !== legalVersion
  )
    throw new Error("Guest consent required");
  return createAccount(
    new D1GuestAccounts(env.APP_DB),
    {
      now: Date.now,
      id: () => crypto.randomUUID(),
      number: () => crypto.getRandomValues(new Uint32Array(1))[0]!,
      async credential() {
        const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        const hash = await guestTokenHash(
          new Request(request.url, { headers: { Cookie: `${cookieName}=${token}` } }),
        );
        return { token, hash };
      },
      issueSession: (token) => appendSessionCookie(request, guestCookie(token, env)),
    },
    name,
    avatarPresetId,
  );
}
export async function clearGuestSession(request: Request, env: Env) {
  const hash = await guestTokenHash(request);
  if (hash) await new D1GuestAccounts(env.APP_DB).clear(hash);
  appendSessionCookie(request, guestCookie("", env, 0));
}
export async function suspendGuestSession(request: Request, env: Env) {
  const hash = await guestTokenHash(request);
  if (hash) await new D1GuestAccounts(env.APP_DB).suspend(hash, Date.now());
}
