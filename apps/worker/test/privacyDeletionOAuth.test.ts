import { legalVersion } from "@tetraboard/protocol/privacy";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { accountIdentity } from "../src/adapters/account/auth";
import { challengeCookie } from "../src/adapters/privacy/deletionCookies";
import { completeReauthentication } from "../src/adapters/privacy/deletionAuthentication";
import { responseCookies } from "../src/adapters/account/authCookies";
import { unsealToken } from "../src/adapters/account/authTokens";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { request, processFixtureDeletion } from "./privacyFixtures";

afterEach(() => vi.restoreAllMocks());

for (const provider of ["google", "discord"] as const)
  test(`${provider}: 実コールバック経路で取消・別人・期限・正常再認証と新規再登録を確認する`, async () => {
    let providerId = String(Date.now()) + String(Math.floor(Math.random() * 100000)),
      email = `${crypto.randomUUID()}@example.test`;
    const cookies = (r: Response) =>
      r.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
    const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/revoke")) return new Response(null, { status: 200 });
      if (url.includes("/token")) {
        const jwt = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ sub: providerId, email, email_verified: true, name: "External private name", picture: "https://private.test/avatar" }))}.fake`;
        return Response.json({
          access_token: "provider-private-token",
          refresh_token: "unneeded-refresh",
          id_token: jwt,
          token_type: "Bearer",
          expires_in: 3600,
          scope: provider === "google" ? "openid email profile" : "identify email",
        });
      }
      if (decodeURIComponent(url).endsWith("/users/@me"))
        return Response.json({
          id: providerId,
          email,
          username: "外部非公開名",
          verified: true,
          avatar: null,
          discriminator: "0",
        });
      throw new Error("Unexpected OAuth request");
    });
    const signIn = async (admin = false) => {
      const analytics = { id: crypto.randomUUID(), entry: "login-page", game: null };
      const response = await request("/auth/sign-in/social", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Legal-Consent": legalVersion,
        },
        body: JSON.stringify({ provider, ...(admin ? { destination: "admin" } : { analytics }) }),
      });
      expect(response.status).toBe(200);
      const url = new URL(((await response.json()) as { url: string }).url);
      if (provider === "google") {
        expect(url.searchParams.get("access_type")).toBe("online");
        expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual([
          "email",
          "openid",
          "profile",
        ]);
      }
      return { state: url.searchParams.get("state")!, cookie: cookies(response), analytics };
    };
    const callback = async (flow: { state: string; cookie: string }, cancel = false) =>
      request(
        `/auth/callback/${provider}?${cancel ? "error=access_denied" : "code=test-code"}&state=${encodeURIComponent(flow.state)}`,
        { headers: { Cookie: flow.cookie } },
      );
    const firstFlow = await signIn();
    const first = await callback(firstFlow);
    const initialCookie = responseCookies(new Request(origin), first).get("Cookie")!;
    const user = (await env.APP_DB.prepare("SELECT id,name,image FROM user WHERE email=?")
      .bind(email)
      .first<{ id: string; name: string; image: string | null }>())!;
    expect(user.name).toBe("");
    expect(user.image).toBeNull();
    const form = new FormData();
    form.set("name", "計測登録");
    form.set("username", `metric_${user.id.slice(0, 8)}`);
    form.set("avatarAction", "keep");
    form.set("consentVersion", legalVersion);
    const encoded = new Request(`${origin}/api/account/setup`, {
      method: "POST",
      headers: { Cookie: initialCookie, Origin: origin },
      body: form,
    });
    const setup = await request("/account/setup", {
      method: "POST",
      headers: encoded.headers,
      body: await encoded.arrayBuffer(),
    });
    expect(setup.status).toBe(200);
    const existingFlow = await signIn();
    await callback(existingFlow);
    await callback(existingFlow);
    const canceledLogin = await signIn();
    await callback(canceledLogin, true);

    if (provider === "google") {
      const adminLogin = await callback(await signIn(true));
      expect(adminLogin.headers.get("Location")).toContain("/admin");
    }
    expect(
      await env.APP_DB.prepare("SELECT version FROM legal_consents WHERE account_id=?")
        .bind(user.id)
        .first(),
    ).toEqual({ version: legalVersion });
    const tokens = await env.APP_DB.prepare(
      "SELECT accessToken,refreshToken,idToken FROM account WHERE userId=?",
    )
      .bind(user.id)
      .first<{ accessToken: string; refreshToken: null; idToken: null }>();
    expect(tokens?.refreshToken).toBeNull();
    expect(tokens?.idToken).toBeNull();
    expect(tokens?.accessToken).not.toBe("provider-private-token");
    expect(await unsealToken(env, tokens!.accessToken)).toBe("provider-private-token");
    const reauth = async (cookie: string) => {
      const response = await request("/account/deletion/reauth", {
        method: "POST",
        headers: { Origin: origin, Cookie: cookie },
      });
      expect(response.status).toBe(200);
      const url = new URL(((await response.json()) as { url: string }).url);
      expect(url.searchParams.get("prompt")).toBe(
        provider === "google" ? "select_account" : "consent",
      );
      return {
        state: url.searchParams.get("state")!,
        cookie: responseCookies(new Request(origin, { headers: { Cookie: cookie } }), response).get(
          "Cookie",
        )!,
      };
    };
    expect(
      await accountIdentity(new Request(origin, { headers: { Cookie: initialCookie } }), env),
    ).not.toBeNull();
    const canceled = await reauth(initialCookie);
    await callback(canceled, true);
    expect(
      await env.APP_DB.prepare("SELECT verified_at_ms FROM deletion_challenges WHERE oauth_state=?")
        .bind(canceled.state)
        .first(),
    ).toEqual({ verified_at_ms: null });
    const wrong = await reauth(initialCookie);
    const originalId = providerId,
      originalEmail = email;
    providerId = String(Date.now()) + String(Math.floor(Math.random() * 100000));
    email = `${crypto.randomUUID()}@example.test`;
    await callback(wrong);
    expect(
      await env.APP_DB.prepare("SELECT verified_at_ms FROM deletion_challenges WHERE oauth_state=?")
        .bind(wrong.state)
        .first(),
    ).toEqual({ verified_at_ms: null });
    providerId = originalId;
    email = originalEmail;
    const expired = await reauth(initialCookie);
    await env.APP_DB.prepare("UPDATE deletion_challenges SET expires_at_ms=? WHERE oauth_state=?")
      .bind(Date.now() - 1, expired.state)
      .run();
    await callback(expired);
    expect(
      await env.APP_DB.prepare("SELECT verified_at_ms FROM deletion_challenges WHERE oauth_state=?")
        .bind(expired.state)
        .first(),
    ).toEqual({ verified_at_ms: null });
    const valid = await reauth(initialCookie);
    const authenticated = await callback(valid);
    const newCookie = `${valid.cookie
      .split("; ")
      .filter((v) => !v.startsWith("tetraboard-2026.session_token="))
      .join("; ")}; ${cookies(authenticated)}`;
    const row = await env.APP_DB.prepare(
      "SELECT verified_at_ms,verified_session_id FROM deletion_challenges WHERE oauth_state=?",
    )
      .bind(valid.state)
      .first<{ verified_at_ms: number; verified_session_id: string }>();
    expect(row!.verified_at_ms).toBeGreaterThan(0);
    expect(row!.verified_session_id).toBeTruthy();
    expect(
      (await request("/account/deletion/confirmation", { headers: { Cookie: newCookie } })).status,
    ).toBe(200);
    const response = await request("/account/deletion/confirm", {
      method: "POST",
      headers: { Origin: origin, Cookie: newCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(response.status).toBe(202);
    await env.APP_DB.prepare("DELETE FROM deletion_rooms WHERE account_id=?").bind(user.id).run();
    await processFixtureDeletion(user.id);
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM account WHERE userId=?").bind(user.id).first(),
    ).toBeNull();
    await callback(await signIn());
    const fresh = await env.APP_DB.prepare("SELECT id FROM user WHERE email=?")
      .bind(email)
      .first<{ id: string }>();
    expect(fresh!.id).not.toBe(user.id);
    mock.mockRestore();
  });

test("本番の__Secure認証Cookieでも同意・再認証を保存し、退会時に失効Cookieを返す", async () => {
  const production = "https://tetraboard.net" as const,
    bindings = { ...env, APP_ORIGIN: production },
    email = `${crypto.randomUUID()}@example.test`,
    subject = crypto.randomUUID();
  const call = (path: string, init?: RequestInit) =>
    worker.fetch(
      new Request(`${production}/api${path}`, { redirect: "manual", ...init }),
      bindings,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
  const jwt = `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify({ sub: subject, email, email_verified: true, name: "private" }))}.fake`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      access_token: "secure-provider-token",
      id_token: jwt,
      token_type: "Bearer",
      expires_in: 3600,
    }),
  );
  const begin = await call("/auth/sign-in/social", {
    method: "POST",
    headers: {
      Origin: production,
      "Content-Type": "application/json",
      "X-Legal-Consent": legalVersion,
    },
    body: JSON.stringify({ provider: "google" }),
  });
  expect(begin.status).toBe(200);
  const state = new URL(((await begin.json()) as { url: string }).url).searchParams.get("state")!;
  const flow = responseCookies(new Request(production), begin).get("Cookie")!;
  const done = await call(
    `/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: flow } },
  );
  const cookie = responseCookies(new Request(production, { headers: { Cookie: flow } }), done).get(
    "Cookie",
  )!;
  expect(cookie).toContain("__Secure-tetraboard-2026.session_token=");
  const user = (await env.APP_DB.prepare("SELECT id FROM user WHERE email=?")
    .bind(email)
    .first<{ id: string }>())!;
  expect(
    await env.APP_DB.prepare("SELECT version FROM legal_consents WHERE account_id=?")
      .bind(user.id)
      .first(),
  ).toEqual({ version: legalVersion });
  const start = await call("/account/deletion/reauth", {
    method: "POST",
    headers: { Origin: production, Cookie: cookie },
  });
  expect(start.status).toBe(200);
  const url = new URL(((await start.json()) as { url: string }).url),
    challenge = responseCookies(
      new Request(production, { headers: { Cookie: cookie } }),
      start,
    ).get("Cookie")!;
  const authenticated = await call(
    `/auth/callback/google?code=test-code&state=${encodeURIComponent(url.searchParams.get("state")!)}`,
    { headers: { Cookie: challenge } },
  );
  const fresh = responseCookies(
    new Request(production, { headers: { Cookie: challenge } }),
    authenticated,
  ).get("Cookie")!;
  const response = await call("/account/deletion/confirm", {
    method: "POST",
    headers: { Origin: production, Cookie: fresh, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  expect(response.status).toBe(202);
  expect(response.headers.getSetCookie()).toContain(
    "__Secure-tetraboard-2026.session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure",
  );
});

test("再認証のキャンセル応答は同時刻の既存セッションを本人確認に使わない", async () => {
  const user = await accountFixture();
  const session = await env.APP_DB.prepare("SELECT createdAt FROM session WHERE token=?")
    .bind(user.token)
    .first<{ createdAt: number }>();
  const id = crypto.randomUUID(),
    state = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO deletion_challenges(id,account_id,provider,created_at_ms,expires_at_ms,oauth_state) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, user.id, "google", session!.createdAt, Date.now() + 600000, state)
    .run();
  await completeReauthentication(
    new Request(`${origin}/api/auth/callback/google?error=access_denied&state=${state}`, {
      headers: { Cookie: `${user.cookie}; ${challengeCookie}=${id}` },
    }),
    new Response(null, { status: 302, headers: { Location: `${origin}/account/deletion` } }),
    env,
  );
  expect(
    await env.APP_DB.prepare("SELECT verified_at_ms FROM deletion_challenges WHERE id=?")
      .bind(id)
      .first(),
  ).toEqual({ verified_at_ms: null });
});
