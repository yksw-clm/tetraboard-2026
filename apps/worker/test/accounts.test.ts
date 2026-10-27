import { legalVersion } from "@tetraboard/protocol/privacy";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env, exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { createRoomContract } from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import { createAuth } from "../src/accounts/auth";
import { deleteUnusedAvatars, validAvatar } from "../src/accounts/accountRoutes";
import { dispatchInTestContext } from "./dispatchInTestContext";
const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(`${origin}/api${path}`, init));
const webp = () => {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 24, true);
  view.setUint32(16, 12, true);
  bytes[20] = 0x2f;
  view.setUint32(21, 255 | (255 << 14), true);
  return bytes;
};
const form = (name: string, username: string, avatarAction = "keep", bytes?: Uint8Array) => {
  const data = new FormData();
  data.set("consentVersion", legalVersion);
  data.set("name", name);
  data.set("username", username);
  data.set("avatarAction", avatarAction);
  if (bytes) data.set("avatar", new File([bytes], "avatar.webp", { type: "image/webp" }));
  return data;
};
const write = async (cookie: string, data: FormData, setup = false, from = origin) => {
  const path = setup ? "/account/setup" : "/account/profile";
  const method = setup ? "POST" : "PATCH";
  const encoded = new Request(`${origin}/api${path}`, {
    method,
    headers: { Cookie: cookie, Origin: from },
    body: data,
  });
  // multipartの遅延streamを別リクエストへ渡さず、実HTTPと同様に符号化済みbodyを送ります。
  const body = await encoded.arrayBuffer();
  return request(path, { method, headers: encoded.headers, body });
};
test("未認証・期限切れ・改ざんCookieを拒否し、Googleログアウトで失効する", async () => {
  expect(await (await request("/account/session")).json()).toEqual({ user: null });
  expect((await write("", form("名前", "valid_id"))).status).toBe(401);
  const user = await accountFixture();
  expect(
    (await request("/account/session", { headers: { Cookie: user.cookie } })).headers.get(
      "cache-control",
    ),
  ).toBe("no-store");
  expect(
    await (
      await request("/account/session", { headers: { Cookie: user.cookie + "tampered" } })
    ).json(),
  ).toEqual({ user: null });
  expect(
    (await request("/auth/sign-out", { method: "POST", headers: user.headers, body: "{}" })).status,
  ).toBe(200);
  expect(
    await (await request("/account/session", { headers: { Cookie: user.cookie } })).json(),
  ).toEqual({ user: null });
  const expired = await accountFixture();
  await env.APP_DB.prepare("UPDATE session SET expiresAt = 0 WHERE token = ?")
    .bind(expired.token)
    .run();
  expect(
    await (await request("/account/session", { headers: { Cookie: expired.cookie } })).json(),
  ).toEqual({ user: null });
});
test("初回設定、名前とIDの境界、正規化、重複、更新状態、CSRFを検証する", async () => {
  const user = await accountFixture(false);
  expect((await write(user.cookie, form("名前", "valid_id"))).status).toBe(409);
  for (const [name, id] of [
    [" ", "valid_id"],
    ["あ".repeat(11), "valid_id"],
    ["名前", "ab"],
    ["名前", "a".repeat(21)],
    ["名前", "日本語"],
  ])
    expect((await write(user.cookie, form(name, id), true)).status).toBe(400);
  const id = `MiX_${user.id.slice(0, 8)}`;
  const result = await write(user.cookie, form(` ${"👨‍👩‍👧‍👦".repeat(10)} `, `@${id}`), true);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    username: id.toLowerCase(),
    profileCompleted: true,
    avatarUrl: null,
  });
  expect((await write(user.cookie, form("名前", id), true)).status).toBe(409);
  const other = await accountFixture();
  expect((await write(user.cookie, form("名前", other.username.toUpperCase()))).status).toBe(409);
  expect(
    (await write(user.cookie, form("名前", "valid_id"), false, "https://other.test")).status,
  ).toBe(403);
  const update = await write(user.cookie, form("新しい名前", `new_${user.id.slice(0, 8)}`));
  expect(update.status).toBe(200);
  expect(
    await (await request("/account/session", { headers: { Cookie: user.cookie } })).json(),
  ).toMatchObject({ user: { name: "新しい名前" } });
});
test("IDの同時取得は片方だけ成功し、汎用更新・別プロバイダーのAPIを公開しない", async () => {
  const users = await Promise.all([accountFixture(false), accountFixture(false)]);
  const id = `same_${crypto.randomUUID().slice(0, 8)}`;
  const requests = await Promise.all(
    users.map(async (user) => {
      const request = new AcceptedGameRequest(`${origin}/api/account/setup`, {
        method: "POST",
        headers: { Cookie: user.cookie, Origin: origin },
        body: form("名前", id),
      });
      const body = await request.arrayBuffer();
      return new AcceptedGameRequest(request.url, {
        method: request.method,
        headers: request.headers,
        body,
      });
    }),
  );
  const responses = await Promise.all(requests.map(dispatchInTestContext));
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  for (const path of ["/auth/update-user", "/auth/link-social", "/auth/sign-up/email"])
    expect(
      (await request(path, { method: "POST", headers: users[0].headers, body: "{}" })).status,
    ).toBe(404);
  expect((await request("/auth/callback/discord")).status).toBe(404);
});
test("画像の保存・置換・削除、重複ID時のロールバックと削除失敗の再試行", async () => {
  const user = await accountFixture();
  expect(validAvatar(webp())).toBe(true);
  const invalid = webp();
  invalid[8] = 0;
  expect((await write(user.cookie, form("名前", user.username, "replace", invalid))).status).toBe(
    400,
  );
  const tooLarge = new Uint8Array(1024 * 1024 + 8193);
  expect((await write(user.cookie, form("名前", user.username, "replace", tooLarge))).status).toBe(
    413,
  );
  const upload = await write(user.cookie, form("名前", user.username, "replace", webp()));
  expect(upload.status).toBe(200);
  const first = (await upload.json()) as { avatarUrl: string };
  const image = await exports.default.fetch(new AcceptedGameRequest(`${origin}${first.avatarUrl}`));
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/webp");
  expect(image.headers.get("x-content-type-options")).toBe("nosniff");
  const other = await accountFixture();
  const before = await env.OBJECT_STORAGE.list({ prefix: "avatars/" });
  expect((await write(user.cookie, form("名前", other.username, "replace", webp()))).status).toBe(
    409,
  );
  expect((await env.OBJECT_STORAGE.list({ prefix: "avatars/" })).objects.length).toBe(
    before.objects.length,
  );
  expect(
    await (await request("/account/session", { headers: { Cookie: user.cookie } })).json(),
  ).toMatchObject({ user: { avatarUrl: first.avatarUrl } });
  const second = (await (
    await write(user.cookie, form("名前", user.username, "replace", webp()))
  ).json()) as { avatarUrl: string };
  await deleteUnusedAvatars(env);
  expect(
    (await exports.default.fetch(new AcceptedGameRequest(`${origin}${first.avatarUrl}`))).status,
  ).toBe(404);
  expect((await write(user.cookie, form("名前", user.username, "remove"))).status).toBe(200);
  await deleteUnusedAvatars(env);
  expect(
    (await exports.default.fetch(new AcceptedGameRequest(`${origin}${second.avatarUrl}`))).status,
  ).toBe(404);
  const key = `avatars/${crypto.randomUUID()}.webp`;
  await env.OBJECT_STORAGE.put(key, webp());
  await env.APP_DB.prepare("INSERT INTO avatar_deletions VALUES (?)").bind(key).run();
  await deleteUnusedAvatars({
    ...env,
    OBJECT_STORAGE: {
      delete: async () => {
        throw new Error();
      },
    },
  } as unknown as Env);
  expect(
    await env.APP_DB.prepare("SELECT key FROM avatar_deletions WHERE key = ?").bind(key).first(),
  ).toBeTruthy();
  await deleteUnusedAvatars(env);
  expect(await env.OBJECT_STORAGE.get(key)).toBeNull();
});
test("ログイン参加ではプロフィールを使い、Cookieだけでは席の操作資格にならない", async () => {
  const user = await accountFixture();
  const response = await request("/rooms", {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify({ name: "対局の名前", quickPlay: false, mode: "singles" }),
  });
  expect(response.status).toBe(201);
  const { room, membership } = createRoomContract.response.parse(await response.json());
  expect(room.players[0].name).toBe("登録名");
  expect(JSON.stringify(room)).not.toContain(user.id);
  expect((await request(`/rooms/${room.id}/me`, { headers: { Cookie: user.cookie } })).status).toBe(
    401,
  );
  await request(`/rooms/${room.id}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${membership.token}` },
  });
});
test("Google OAuth往復・キャンセル・state検証・既存プロフィールと旧文字列IDを保持する", async () => {
  const auth = createAuth(env);
  const fetchMock = vi.spyOn(globalThis, "fetch");
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("publicKey" in pair)) throw new Error("RSA key pair required");
  const signingKey = pair.privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const encode = (value: string | Uint8Array) =>
    btoa(
      String.fromCharCode(...(typeof value === "string" ? new TextEncoder().encode(value) : value)),
    )
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  async function start() {
    const response = await request("/auth/sign-in/social", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "google", callbackURL: "https://evil.test" }),
    });
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    expect(new URL(url).origin).toBe("https://accounts.google.com");
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(
      `${origin}/api/auth/callback/google`,
    );
    return {
      state: new URL(url).searchParams.get("state")!,
      cookie: response.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
    };
  }
  async function login(sub: string, email: string) {
    const flow = await start();
    const payload = `${encode(JSON.stringify({ alg: "RS256", kid: "profile-test-key" }))}.${encode(JSON.stringify({ sub, iss: "https://accounts.google.com", aud: "test-google", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, name: "非公開のGoogle名", email, email_verified: true, picture: "https://example.test/private-avatar" }))}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      signingKey,
      new TextEncoder().encode(payload),
    );
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://www.googleapis.com/oauth2/v3/certs")
        return Response.json({ keys: [{ ...jwk, kid: "profile-test-key", alg: "RS256" }] });
      if (url === "https://oauth2.googleapis.com/token")
        return Response.json({
          id_token: `${payload}.${encode(new Uint8Array(signature))}`,
          access_token: "fake-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      throw new Error("Unexpected OAuth request");
    });
    const response = await auth.handler(
      new AcceptedGameRequest(
        `${origin}/api/auth/callback/google?code=test-code&state=${encodeURIComponent(flow.state)}`,
        { headers: { Cookie: flow.cookie } },
      ),
    );
    return { response, flow };
  }
  try {
    const sub = `google-${crypto.randomUUID()}`;
    const email = `${crypto.randomUUID()}@example.test`;
    const first = await login(sub, email);
    expect(first.response.status).toBe(302);
    expect(first.response.headers.get("location")).toContain("/account/setup");
    const user = await env.APP_DB.prepare(
      "SELECT id, name, image, profileCompleted FROM user WHERE email = ?",
    )
      .bind(email)
      .first<{ id: string }>();
    expect(user).toMatchObject({ name: "", image: null, profileCompleted: 0 });
    await env.APP_DB.prepare(
      "UPDATE user SET name = ?, username = ?, profileCompleted = 1 WHERE id = ?",
    )
      .bind("公開名", `oauth_${crypto.randomUUID().slice(0, 8)}`, user!.id)
      .run();
    const second = await login(sub, email);
    expect(second.response.headers.get("location")).toContain("/account");
    expect(
      await env.APP_DB.prepare("SELECT name, image FROM user WHERE id = ?").bind(user!.id).first(),
    ).toEqual({ name: "公開名", image: null });
    const replay = await auth.handler(
      new AcceptedGameRequest(
        `${origin}/api/auth/callback/google?code=test-code&state=${encodeURIComponent(second.flow.state)}`,
        { headers: { Cookie: second.flow.cookie } },
      ),
    );
    expect(replay.headers.get("location")).toContain("error=");
    const flow = await start();
    const forged = await auth.handler(
      new AcceptedGameRequest(`${origin}/api/auth/callback/google?code=test-code&state=wrong`, {
        headers: { Cookie: flow.cookie },
      }),
    );
    expect(forged.headers.get("location")).toContain("error=");
    const cancel = await auth.handler(
      new AcceptedGameRequest(
        `${origin}/api/auth/callback/google?error=access_denied&state=${encodeURIComponent(flow.state)}`,
        { headers: { Cookie: flow.cookie } },
      ),
    );
    expect(cancel.headers.get("location")).toContain("/login?error=");
    const missingCookie = await login(`new-${sub}`, `new-${email}`);
    expect(
      (
        await auth.handler(
          new AcceptedGameRequest(
            `${origin}/api/auth/callback/google?code=test-code&state=${encodeURIComponent(missingCookie.flow.state)}`,
          ),
        )
      ).headers.get("location"),
    ).toContain("error=");
    const legacy = await accountFixture(
      true,
      `legacy${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    );
    await env.APP_DB.prepare(
      "INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, 'google', ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), `legacy-${sub}`, legacy.id, Date.now(), Date.now())
      .run();
    const migrated = await login(`legacy-${sub}`, `${legacy.id}@example.test`);
    expect(migrated.response.headers.get("location")).toContain("/account");
    expect(
      await env.APP_DB.prepare("SELECT id, name, username FROM user WHERE id = ?")
        .bind(legacy.id)
        .first(),
    ).toEqual({ id: legacy.id, name: "登録名", username: legacy.username });
    const cookie = migrated.response.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    expect(
      await (await request("/account/session", { headers: { Cookie: cookie } })).json(),
    ).toMatchObject({ user: { name: "登録名", username: legacy.username } });
  } finally {
    fetchMock.mockRestore();
  }
});
