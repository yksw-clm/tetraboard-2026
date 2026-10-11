import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env, exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { accountRoutes } from "../src/accounts/accountRoutes";
import { accountFixture, origin } from "./accountFixtures";

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(
    new AcceptedGameRequest(`${origin}/api${path}`, { redirect: "manual", ...init }),
  );
const signIn = (body: unknown = { provider: "discord" }) =>
  request("/auth/sign-in/social", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Legal-Consent": "2026-10-12",
    },
    body: JSON.stringify(body),
  });
async function start(body?: unknown) {
  const response = await signIn(body);
  expect(response.status).toBe(200);
  const url = new URL(((await response.json()) as { url: string }).url);
  expect(url.origin).toBe("https://discord.com");
  expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/callback/discord`);
  expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual(["email", "identify"]);
  return {
    state: url.searchParams.get("state")!,
    cookie: response.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; "),
  };
}
const callback = (
  flow: Awaited<ReturnType<typeof start>>,
  query = "code=test-code",
  withCookie = true,
) =>
  request(`/auth/callback/discord?${query}&state=${encodeURIComponent(flow.state)}`, {
    headers: withCookie ? { Cookie: flow.cookie } : {},
  });

test("Discord OAuthは新規登録・再ログインで同じ本人を保持し、メール欠落とGoogleとの競合を拒否", async () => {
  let id = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  let email: string | null = `${crypto.randomUUID()}@example.test`;
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://discord.com/api/oauth2/token")
      return Response.json({
        access_token: "fake-discord-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "identify email",
      });
    if (decodeURIComponent(url) === "https://discord.com/api/users/@me")
      return Response.json({
        id,
        email,
        username: "非公開Discord名",
        global_name: "外部名",
        avatar: null,
        discriminator: "0",
        verified: true,
      });
    throw new Error(`Unexpected Discord request: ${url}`);
  });
  try {
    const first = await callback(
      await start({
        provider: "discord",
        callbackURL: "https://evil.test",
        newUserCallbackURL: "https://evil.test",
        errorCallbackURL: "https://evil.test?error=oauth",
      }),
    );
    expect(first.headers.get("location")).toContain("/account/setup");
    const user = await env.APP_DB.prepare(
      "SELECT id, name, image, profileCompleted FROM user WHERE email = ?",
    )
      .bind(email)
      .first<{ id: string }>();
    expect(user).toMatchObject({ name: "", image: null, profileCompleted: 0 });
    await env.APP_DB.prepare(
      "UPDATE user SET name = ?, username = ?, profileCompleted = 1 WHERE id = ?",
    )
      .bind("公開プロフィール", `discord_${crypto.randomUUID().slice(0, 8)}`, user!.id)
      .run();
    const flow = await start();
    const second = await callback(flow);
    expect(new URL(second.headers.get("location")!, origin).href).toBe(`${origin}/account`);
    expect(
      await env.APP_DB.prepare("SELECT name, image, profileCompleted FROM user WHERE id = ?")
        .bind(user!.id)
        .first(),
    ).toEqual({ name: "公開プロフィール", image: null, profileCompleted: 1 });
    const cookie = second.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    expect(
      await (await request("/account/session", { headers: { Cookie: cookie } })).json(),
    ).toMatchObject({ user: { name: "公開プロフィール", profileCompleted: true } });
    expect((await callback(flow)).headers.get("location")).toContain("error=");
    expect(
      (await callback(await start(), "code=test-code", false)).headers.get("location"),
    ).toContain("error=");
    expect(
      (await callback(await start(), "error=access_denied")).headers.get("location"),
    ).toContain("/login?error=");
    expect(
      (await request("/auth/callback/discord?code=test-code&state=wrong")).headers.get("location"),
    ).toContain("error=");

    id = `${Date.now()}11111`;
    email = null;
    const missing = await callback(await start());
    const missingURL = new URL(missing.headers.get("location")!, origin);
    expect(missingURL.pathname).toBe("/login");
    expect(missingURL.searchParams.getAll("error")).toEqual(["email_not_found"]);
    expect(
      await env.APP_DB.prepare(
        "SELECT id FROM account WHERE providerId = 'discord' AND accountId = ?",
      )
        .bind(id)
        .first(),
    ).toBeNull();

    const google = await accountFixture(true);
    email = `${google.id}@example.test`;
    id = `${Date.now()}22222`;
    const before = await env.APP_DB.prepare(
      "SELECT id, name, username, profileCompleted FROM user WHERE id = ?",
    )
      .bind(google.id)
      .first();
    const conflict = await callback(await start());
    const conflictURL = new URL(conflict.headers.get("location")!, origin);
    expect(conflictURL.pathname).toBe("/login");
    expect(conflictURL.searchParams.getAll("error")).toEqual(["account_not_linked"]);
    expect(
      await env.APP_DB.prepare("SELECT id, name, username, profileCompleted FROM user WHERE id = ?")
        .bind(google.id)
        .first(),
    ).toEqual(before);
    expect(
      await env.APP_DB.prepare(
        "SELECT id FROM account WHERE providerId = 'discord' AND accountId = ?",
      )
        .bind(id)
        .first(),
    ).toBeNull();
  } finally {
    mock.mockRestore();
  }
});

test.each([undefined, "admin"])(
  "Google OAuth取消でエラーを1件だけ渡し、管理画面の戻り先を保持する: %s",
  async (destination) => {
    const response = await signIn({
      provider: "google",
      destination,
      errorCallbackURL: "https://evil.test",
    });
    expect(response.status).toBe(200);
    const authorization = new URL(((await response.json()) as { url: string }).url);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const canceled = await request(
      `/auth/callback/google?error=access_denied&state=${encodeURIComponent(authorization.searchParams.get("state")!)}`,
      { headers: { Cookie: cookie } },
    );
    const location = new URL(canceled.headers.get("location")!, origin);
    expect(location.origin).toBe(origin);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.getAll("error")).toEqual(["access_denied"]);
    expect(location.searchParams.get("destination")).toBe(destination ?? null);
  },
);

test("認証方法の許可リスト・固定戻り先・管理画面Google限定・設定不足を確認", async () => {
  for (const provider of ["github", "", null, 1])
    expect((await signIn({ provider })).status).toBe(400);
  expect((await signIn(null)).status).toBe(400);
  expect((await signIn({ provider: "discord", destination: "admin" })).status).toBe(400);
  expect((await request("/auth/callback/github")).status).toBe(404);
  expect((await request("/auth/link-social", { method: "POST" })).status).toBe(404);
  expect(
    (
      await request("/auth/sign-in/social", {
        method: "POST",
        headers: { Origin: "https://evil.test" },
        body: JSON.stringify({ provider: "discord" }),
      })
    ).status,
  ).toBe(403);
  const google = await signIn({});
  expect(google.status).toBe(200);
  expect(new URL(((await google.json()) as { url: string }).url).origin).toBe(
    "https://accounts.google.com",
  );
  const init = {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Legal-Consent": "2026-10-12",
    },
    body: JSON.stringify({ provider: "discord" }),
  };
  const missing = await accountRoutes.request(`${origin}/auth/sign-in/social`, init, {
    ...env,
    DISCORD_CLIENT_ID: "",
  });
  expect(missing.status).toBe(503);
  expect(await missing.json()).toEqual({ message: "Discordログインは準備中です。" });
  const independent = await accountRoutes.request(`${origin}/auth/sign-in/social`, init, {
    ...env,
    DISCORD_CLIENT_ID: "test-discord",
    DISCORD_CLIENT_SECRET: "test-discord-secret",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
  });
  expect(independent.status).toBe(200);
});
