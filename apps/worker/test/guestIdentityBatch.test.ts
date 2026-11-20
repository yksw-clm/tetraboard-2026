import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { legalVersion } from "@tetraboard/protocol/privacy";
import {
  guestIdentity,
  createGuestAccount,
  guestTokenHash,
  guestLifetimeMs,
} from "../src/routes/guestSession";
import { withAccountSessionCookies } from "../src/adapters/account/auth";
import { accountFixture, origin } from "./accountFixtures";
import { fixTestTime } from "./fixedTimeFixture";
const now = 1794900000000;
async function guest() {
  const request = new Request(origin, {
    headers: { Origin: origin, "X-Legal-Consent": legalVersion },
  });
  let id = "";
  const response = await withAccountSessionCookies(request, async () => {
    id = (await createGuestAccount(request, env, "本人確認")).id;
    return new Response(null);
  });
  const cookie = response.headers.getSetCookie()[0]!.split(";")[0]!;
  const identityRequest = new Request(origin, { headers: { Cookie: cookie } });
  const hash = (await guestTokenHash(identityRequest))!;
  return { id, cookie, hash, request: identityRequest };
}
function observeDatabase() {
  const queries: string[] = [];
  const batches: number[] = [];
  const db = new Proxy(env.APP_DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          queries.push(sql);
          return target.prepare(sql);
        };
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          batches.push(statements.length);
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, queries, batches };
}
async function expiry(hash: string) {
  return (await env.APP_DB.prepare("SELECT expires_at_ms FROM guest_sessions WHERE token_hash=?")
    .bind(hash)
    .first<{ expires_at_ms: number }>())!.expires_at_ms;
}
test("ゲスト本人確認は1回のbatchで条件つきUPDATEとSELECTを実行し、180日とCookieを更新します", async () => {
  const clock = fixTestTime(now);
  const g = await guest();
  clock.mockReturnValue(now + 86400000);
  const observed = observeDatabase();
  let identity;
  const response = await withAccountSessionCookies(g.request, async () => {
    identity = await guestIdentity(g.request, { ...env, APP_DB: observed.db });
    return new Response(null);
  });
  expect(identity).toMatchObject({ id: g.id, name: "本人確認", isAnonymous: 1 });
  expect(observed.batches).toEqual([2]);
  expect(observed.queries).toHaveLength(2);
  expect(observed.queries[0]).toMatch(/^UPDATE guest_sessions/);
  expect(observed.queries[1]).toMatch(/^SELECT u\.\*/);
  expect(await expiry(g.hash)).toBe(now + 86400000 + guestLifetimeMs);
  expect(response.headers.getSetCookie()).toEqual([
    `${g.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000`,
  ]);
});
async function invalidate(kind: string, g: Awaited<ReturnType<typeof guest>>) {
  if (kind === "expired" || kind === "boundary")
    await env.APP_DB.prepare("UPDATE guest_sessions SET expires_at_ms=? WHERE token_hash=?")
      .bind(now - (kind === "expired" ? 1 : 0), g.hash)
      .run();
  else if (kind === "registered")
    await env.APP_DB.prepare("UPDATE guest_sessions SET registered_at_ms=? WHERE token_hash=?")
      .bind(now, g.hash)
      .run();
  else if (kind === "notAnonymous")
    await env.APP_DB.prepare("UPDATE user SET isAnonymous=0 WHERE id=?").bind(g.id).run();
  else if (kind === "deleted")
    await env.APP_DB.prepare(
      "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,?,?)",
    )
      .bind(g.id, now, crypto.randomUUID())
      .run();
  else await merge(g);
}
async function merge(g: Awaited<ReturnType<typeof guest>>) {
  const target = await accountFixture();
  const session = await env.APP_DB.prepare("SELECT id FROM session WHERE userId=?")
    .bind(target.id)
    .first<{ id: string }>();
  await env.APP_DB.prepare(
    `INSERT INTO guest_oauth_flows(state,guest_id,guest_token_hash,provider,started_at_ms,expires_at_ms,target_id,target_session_id) VALUES(?,?,?,'google',?,?,?,?)`,
  )
    .bind(crypto.randomUUID(), g.id, g.hash, now, now + 60000, target.id, session!.id)
    .run();
  await env.APP_DB.prepare(
    "INSERT INTO guest_account_merges(guest_id,account_id,merged_at_ms) VALUES(?,?,?)",
  )
    .bind(g.id, target.id, now)
    .run();
}
for (const kind of ["expired", "boundary", "registered", "notAnonymous", "deleted", "merged"])
  test(`${kind}: 無効なセッションの期限を延ばさず、Cookieを再発行しません`, async () => {
    fixTestTime(now);
    const g = await guest();
    await invalidate(kind, g);
    const before = await expiry(g.hash);
    const observed = observeDatabase();
    const response = await withAccountSessionCookies(g.request, async () => {
      expect(await guestIdentity(g.request, { ...env, APP_DB: observed.db })).toBeNull();
      return new Response(null);
    });
    expect(observed.batches).toEqual([2]);
    expect(await expiry(g.hash)).toBe(before);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
test("ゲストCookieがなければD1を呼びません", async () => {
  const observed = observeDatabase();
  expect(await guestIdentity(new Request(origin), { ...env, APP_DB: observed.db })).toBeNull();
  expect(observed.batches).toEqual([]);
  expect(observed.queries).toEqual([]);
});
