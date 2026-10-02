import { env, exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { createInitialState } from "@tetraboard/four-reversi";
import { createRoomContract, historyPageSchema, rankingSchema } from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";
import {
  persistMatch,
  readStatistics,
  readRanking,
  readHistory,
  type ArchivedMatch,
} from "../src/accounts/historyStore";
import { createAuth } from "../src/accounts/auth";
import { validAvatar } from "../src/accounts/accountRoutes";

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${origin}/api${path}`, init));

test("プロフィール設定・IDの正規化と重複・Cookie本人確認・失効", async () => {
  const user = await accountFixture(false);
  const another = await accountFixture();
  expect((await request("/account/history")).status).toBe(401);
  const profile = await request("/account/session", { headers: user.headers });
  expect(await profile.json()).toMatchObject({ user: { name: "登録名", profileCompleted: false } });
  const create = () =>
    request("/rooms", {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({ name: "偽名", mode: "singles", quickPlay: false }),
    });
  expect((await create()).status).toBe(403);
  const setup = await request("/account/setup", {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify({ name: "👨‍👩‍👧‍👦".repeat(10), username: `MiX_${user.id.slice(0, 8)}` }),
  });
  expect(setup.status).toBe(200);
  expect(await setup.json()).toMatchObject({
    username: `mix_${user.id.slice(0, 8)}`,
    profileCompleted: true,
  });
  const update = (name: string, username: string, headers = user.headers) =>
    request("/account/profile", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name, username }),
    });
  expect((await update("あ".repeat(11), "valid_id")).status).toBe(400);
  expect((await update("名前", another.username.toUpperCase())).status).toBe(409);
  expect(
    (await update("名前", "valid_id", { ...user.headers, Origin: "https://other.test" })).status,
  ).toBe(403);
  const created = await create();
  expect(created.status).toBe(201);
  const body = createRoomContract.response.parse(await created.json());
  expect(body.room.players[0].name).toBe("👨‍👩‍👧‍👦".repeat(10));
  expect(JSON.stringify(body)).not.toContain(user.id);
  const duplicate = await request(`/rooms/${body.room.id}/players`, {
    method: "POST",
    headers: user.headers,
    body: JSON.stringify({ name: "別名" }),
  });
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toEqual({ error: "already_joined" });
  await env.APP_DB.prepare("UPDATE session SET expiresAt = 0 WHERE token = ?")
    .bind(user.token)
    .run();
  expect(await (await request("/account/session", { headers: user.headers })).json()).toEqual({
    user: null,
  });
});

test("IDの同時取得は片方だけ成功し、Better Authの汎用更新で設定を迂回できない", async () => {
  const users = await Promise.all([accountFixture(false), accountFixture(false)]);
  const username = `same_${crypto.randomUUID().slice(0, 8)}`;
  const responses = await Promise.all(
    users.map((user) =>
      request("/account/setup", {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ name: "名前", username }),
      }),
    ),
  );
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    (
      await request("/auth/update-user", {
        method: "POST",
        headers: users[0].headers,
        body: JSON.stringify({ name: "不正" }),
      })
    ).status,
  ).toBe(404);
});

function finishedMatch(userId: string, mode: "singles" | "doubles" = "singles"): ArchivedMatch {
  const colors = ["black", "white", "red", "blue"] as const;
  const players = colors.map((color, i) => ({
    id: crypto.randomUUID(),
    name: i === 0 ? "当時の名前" : `CPU Lv${i === 1 ? 2 : 1}`,
    kind: i === 0 ? ("human" as const) : ("cpu" as const),
    level: i === 1 ? (2 as const) : (1 as const),
    ready: true as const,
    color,
    reconnectDeadline: null,
  }));
  return {
    formatVersion: 1,
    id: crypto.randomUUID(),
    roomId: "12345",
    instanceId: crypto.randomUUID(),
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    players,
    owners: { [players[0].id]: userId },
    replay: null,
    game: {
      ...createInitialState(mode),
      status: "finished",
      turn: null,
      result:
        mode === "singles"
          ? {
              mode,
              reason: "all_passed",
              standings: colors.map((color, i) => ({
                color,
                rank: i < 2 ? 1 : i + 1,
                stoneCount: i < 2 ? 20 : 5,
              })),
            }
          : {
              mode,
              reason: "all_passed",
              winner: null,
              stoneCounts: colors.map((color) => ({ color, count: 2 })),
              teamTotals: { "black-red": 4, "white-blue": 4 },
            },
    },
  };
}

test("旧形式の文字列ユーザーIDで履歴を保存し、同順位・引き分け・所有権・再送を正しく集計", async () => {
  const user = await accountFixture(true, `legacy${crypto.randomUUID().slice(0, 8)}`);
  const other = await accountFixture();
  const singles = finishedMatch(user.id);
  const doubles = finishedMatch(user.id, "doubles");
  await persistMatch(env, singles);
  await persistMatch(env, singles);
  await persistMatch(env, doubles);
  expect(await readStatistics(env.APP_DB, user.id, "singles")).toMatchObject({
    total: 1,
    first: 1,
    second: 0,
  });
  expect(await readStatistics(env.APP_DB, user.id, "doubles")).toMatchObject({
    total: 1,
    draws: 1,
    wins: 0,
  });
  expect((await readHistory(env.APP_DB, other.id, "singles")).entries).toHaveLength(0);
  await env.APP_DB.prepare("UPDATE user SET name = ?, username = ? WHERE id = ?")
    .bind("現在の名前", `new_${user.username}`, user.id)
    .run();
  const history = historyPageSchema.parse(await readHistory(env.APP_DB, user.id, "singles"));
  expect(history.entries[0].players[0].name).toBe("当時の名前");
  const ranking = rankingSchema.parse(await readRanking(env.APP_DB, "singles", "wins"));
  expect(ranking.entries.find((entry) => entry.name === "現在の名前")?.count).toBe(1);
  expect((await env.OBJECT_STORAGE.get(`matches/v1/${singles.id}.json`))?.size).toBeGreaterThan(0);
  const foreignQuery = await request(`/account/history?userId=${user.id}`, {
    headers: other.headers,
  });
  expect(await foreignQuery.json()).toMatchObject({ entries: [] });
  expect((await request("/account/history?cursor=bad", { headers: user.headers })).status).toBe(
    400,
  );
});

test("履歴の追加読み込みは同じ終了時刻でも重複せず、R2失敗時はD1に確定しない", async () => {
  const user = await accountFixture();
  const time = Date.now();
  for (let i = 0; i < 21; i++)
    await persistMatch(env, { ...finishedMatch(user.id), finishedAt: time });
  const first = await readHistory(env.APP_DB, user.id, "singles");
  const second = await readHistory(env.APP_DB, user.id, "singles", first.nextCursor!);
  expect(first.entries).toHaveLength(20);
  expect(second.entries).toHaveLength(1);
  expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(21);
  const match = finishedMatch(user.id);
  const broken = {
    ...env,
    OBJECT_STORAGE: {
      put: async () => {
        throw new Error("R2 unavailable");
      },
    },
  } as unknown as Env;
  await expect(persistMatch(broken, match)).rejects.toThrow("R2 unavailable");
  expect(
    await env.APP_DB.prepare("SELECT id FROM gameMatch WHERE id = ?").bind(match.id).first(),
  ).toBeNull();
});

test("認証の両側メール確認を有効にし、OAuthプロフィールを自動公開しない", async () => {
  const auth = createAuth(env);
  expect(auth.options.account?.accountLinking).toMatchObject({
    enabled: true,
    trustedProviders: [],
    requireLocalEmailVerified: true,
  });
  const before = auth.options.databaseHooks!.user!.create!.before!;
  const mapped = await before({
    id: "oauth",
    name: "Real Name",
    image: "https://example.test/photo",
    email: "p@example.test",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(mapped).toMatchObject({ data: { name: "", image: null } });
  expect(
    (
      await request("/auth/sign-in/social", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google" }),
      })
    ).status,
  ).toBe(503);
  expect(
    (await request("/auth/callback/discord?error=access_denied", { redirect: "manual" })).status,
  ).toBe(302);
});

test("画像形式・容量・認証を検証し、削除は過去画像を保持する", async () => {
  const user = await accountFixture();
  expect(validAvatar(new TextEncoder().encode("<svg></svg>"))).toBe(false);
  expect(
    (
      await request("/account/avatar", {
        method: "PUT",
        headers: { ...user.headers, "Content-Type": "image/webp" },
        body: "invalid",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/account/avatar", {
        method: "PUT",
        headers: {
          ...user.headers,
          "Content-Type": "image/webp",
          "Content-Length": String(2 * 1024 * 1024),
        },
        body: "x",
      })
    ).status,
  ).toBe(413);
  const key = `avatars/${crypto.randomUUID()}.webp`;
  await env.OBJECT_STORAGE.put(key, "fixture");
  await env.APP_DB.prepare("UPDATE user SET image = ?, avatarKey = ? WHERE id = ?")
    .bind("/api/avatars/example", key, user.id)
    .run();
  expect(
    (await request("/account/avatar", { method: "DELETE", headers: user.headers })).status,
  ).toBe(204);
  expect(await env.OBJECT_STORAGE.get(key)).not.toBeNull();
  expect(await (await request("/account/session", { headers: user.headers })).json()).toMatchObject(
    { user: { avatarUrl: null } },
  );
});

test.each(["google", "discord"] as const)(
  "%s OAuthの新規・再ログインと確認済みメール連携",
  async (provider) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const auth = createAuth({
      ...env,
      GOOGLE_CLIENT_ID: "test-google",
      GOOGLE_CLIENT_SECRET: "test-secret",
      DISCORD_CLIENT_ID: "test-discord",
      DISCORD_CLIENT_SECRET: "test-secret",
    });
    const email = `oauth-${crypto.randomUUID()}@example.test`;
    const providerId = "123456789012345678";
    const keys = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    if (!("publicKey" in keys)) throw new Error("RSA key pair was not generated");
    const signingKey = keys.privateKey;
    const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const encode = (value: string | Uint8Array) =>
      btoa(typeof value === "string" ? value : String.fromCharCode(...value))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    async function login(mail: string, verified: boolean) {
      const started = await auth.handler(
        new Request(`${origin}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            callbackURL: "/account",
            newUserCallbackURL: "/account/setup",
            errorCallbackURL: "/login?error=oauth",
          }),
        }),
      );
      expect(started.status).toBe(200);
      const { url } = (await started.json()) as { url: string };
      const state = new URL(url).searchParams.get("state")!;
      const cookie = started.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const payload = `${encode(JSON.stringify({ alg: "RS256", kid: "test-key" }))}.${encode(JSON.stringify({ sub: providerId, iss: "https://accounts.google.com", aud: "test-google", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, name: "Private Name", email: mail, email_verified: verified, picture: "https://example.test/avatar" }))}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        signingKey,
        new TextEncoder().encode(payload),
      );
      const idToken = `${payload}.${encode(new Uint8Array(signature))}`;
      fetchMock.mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === "https://www.googleapis.com/oauth2/v3/certs")
          return Response.json({ keys: [{ ...publicKey, kid: "test-key", alg: "RS256" }] });
        if (
          url === "https://discord.com/api/oauth2/token" ||
          url === "https://oauth2.googleapis.com/token"
        )
          return Response.json({
            id_token: idToken,
            access_token: "fake-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        if (decodeURIComponent(url) === "https://discord.com/api/users/@me")
          return Response.json({
            id: providerId,
            username: "provider-name",
            global_name: "Private Name",
            email: mail,
            verified,
            avatar: null,
            discriminator: "0",
          });
        throw new Error(`Unexpected OAuth request: ${url}`);
      });
      return auth.handler(
        new Request(
          `${origin}/api/auth/callback/${provider}?code=fake-code&state=${encodeURIComponent(state)}`,
          { headers: { Cookie: cookie } },
        ),
      );
    }
    try {
      const first = await login(email, true);
      expect(first.status).toBe(302);
      expect(first.headers.get("location")).toContain("/account/setup");
      const user = await env.APP_DB.prepare(
        "SELECT id, name, image, profileCompleted FROM user WHERE email = ?",
      )
        .bind(email)
        .first<{ id: string; name: string; image: string | null; profileCompleted: number }>();
      expect(user).toMatchObject({ name: "", image: null, profileCompleted: 0 });
      await env.APP_DB.prepare(
        "UPDATE user SET name = ?, username = ?, profileCompleted = 1 WHERE id = ?",
      )
        .bind("公開名", `oauth_${crypto.randomUUID().slice(0, 8)}`, user!.id)
        .run();
      expect((await login(email, true)).headers.get("location")).toContain("/account");
      expect(
        await env.APP_DB.prepare("SELECT name FROM user WHERE id = ?").bind(user!.id).first(),
      ).toEqual({ name: "公開名" });
      // 別プロバイダーだけが連携された旧版アカウントを再現します。
      await env.APP_DB.prepare("UPDATE account SET providerId = ?, accountId = ? WHERE userId = ?")
        .bind(provider === "google" ? "discord" : "google", `other-${user!.id}`, user!.id)
        .run();
      const rejected = await login(email, false);
      expect(rejected.headers.get("location")).toContain("error=");
      expect(
        (
          await env.APP_DB.prepare("SELECT id FROM account WHERE userId = ? AND providerId = ?")
            .bind(user!.id, provider)
            .all()
        ).results,
      ).toHaveLength(0);
      await env.APP_DB.prepare("UPDATE user SET emailVerified = 0 WHERE id = ?")
        .bind(user!.id)
        .run();
      expect((await login(email, true)).headers.get("location")).toContain("error=");
      await env.APP_DB.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?")
        .bind(user!.id)
        .run();
      expect((await login(email, true)).headers.get("location")).toContain("/account");
      expect(
        (
          await env.APP_DB.prepare("SELECT providerId FROM account WHERE userId = ?")
            .bind(user!.id)
            .all()
        ).results,
      ).toHaveLength(2);
    } finally {
      fetchMock.mockRestore();
    }
  },
);
