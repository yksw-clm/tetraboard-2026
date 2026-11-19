import { env, exports } from "cloudflare:workers";
import { afterEach, expect } from "vitest";
import { type AvatarPresetId, accountProfileSchema } from "@tetraboard/protocol";
import { legalVersion } from "@tetraboard/protocol/privacy";
import { accountFixture, origin } from "./accountFixtures";
import { resetDurableObjectStorage } from "./durableObjectCleanup";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { accountIdentity, withAccountSessionCookies } from "../src/adapters/account/auth";
import { rememberGuestLink } from "../src/flows/guestRegistration/guestLink";
import { completeGuestLink } from "../src/routes/guestLinkOAuth";

export const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));

export async function guest(name = "ゲスト本人", avatarPresetId?: AvatarPresetId) {
  const response = await request("/account/guest", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "CF-Connecting-IP": crypto.randomUUID(),
    },
    body: JSON.stringify({ name, avatarPresetId }),
  });
  expect(response.status).toBe(201);
  const user = accountProfileSchema.parse(await response.json());
  const cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("tetraboard-2026.guest="))!
    .split(";")[0]!;
  const headers = {
    Origin: origin,
    Cookie: cookie,
    "Content-Type": "application/json",
    "X-Legal-Consent": legalVersion,
  };
  const identity = await accountIdentity(new Request(origin, { headers }), env);
  return { user, cookie, headers, id: identity!.id };
}

export async function link(
  g: Awaited<ReturnType<typeof guest>>,
  completed = true,
  provider = "google",
) {
  const state = crypto.randomUUID();
  const before = new Request(`${origin}/api/auth/sign-in/social`, { headers: g.headers });
  const identity = (await accountIdentity(before, env))!;
  await rememberGuestLink(before, env, identity, state, provider);
  const target = await accountFixture(completed);
  await env.APP_DB.prepare("UPDATE user SET createdAt=? WHERE id=?")
    .bind(new Date().toISOString(), target.id)
    .run();
  await env.APP_DB.prepare(
    "INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), crypto.randomUUID(), provider, target.id, Date.now(), Date.now())
    .run();
  const callback = new Request(`${origin}/api/auth/callback/${provider}?state=${state}`, {
    headers: { Cookie: g.cookie },
  });
  const response = new Response(null, {
    status: 302,
    headers: { "Set-Cookie": `${target.cookie}; Path=/; HttpOnly`, Location: "/account" },
  });
  await withAccountSessionCookies(callback, async () => {
    await completeGuestLink(callback, response, env);
    return response;
  });
  return { target, state, headers: { ...target.headers, Cookie: `${target.cookie}; ${g.cookie}` } };
}

export function trackGuestAccountRooms() {
  const createdRooms = new Set<string>();
  afterEach(async () => {
    // 他のファイルの障害注入中に、このシナリオのAlarmを残しません。
    for (const id of createdRooms) {
      const stub = env.GAME_ROOM.getByName(id);
      await resetDurableObjectStorage(stub);
    }
    createdRooms.clear();
  });
  return createdRooms;
}
