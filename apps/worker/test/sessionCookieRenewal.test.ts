import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/worker";
import { accountIdentity, createAuth, withAccountSessionCookies } from "../src/accounts/auth";
import type { AdminEnv } from "../src/admin/auth";
import { accountFixture, origin } from "./accountFixtures";

const day = 86_400_000;
const issuedAt = Date.parse("2026-10-01T00:00:00Z");
const context = { waitUntil: () => {} } as unknown as ExecutionContext;
const paths = [
  "/api/account/session",
  "/account/session",
  "/api/account/stats?game=four-reversi",
  "/api/account/matches?game=four-reversi&mode=singles",
  "/api/account/four-shogi/formation-stats",
];
const request = (path: string, cookie?: string, init: RequestInit = {}, bindings: Env = env) =>
  worker.fetch(
    new Request(`${bindings.APP_ORIGIN}${path}`, {
      ...init,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
    }),
    bindings,
    context,
  );
const cookiePair = (cookie: string) => cookie.split(";")[0]!;
async function sessionRow(token: string) {
  const row = await env.APP_DB.prepare("SELECT expiresAt, updatedAt FROM session WHERE token = ?")
    .bind(token)
    .first<{ expiresAt: string | number; updatedAt: string | number }>();
  return row
    ? { expiresAt: new Date(row.expiresAt).getTime(), updatedAt: new Date(row.updatedAt).getTime() }
    : null;
}
async function fixture(completed = true) {
  const user = await accountFixture(completed);
  // 既存fixtureの1日期限をBetter Auth 1.7.5の既定値7日にそろえる。
  await env.APP_DB.prepare("UPDATE session SET expiresAt = ? WHERE token = ?")
    .bind(issuedAt + 7 * day, user.token)
    .run();
  return user;
}
function sessionCookie(response: Response, secure = false) {
  const name = `${secure ? "__Secure-" : ""}tetraboard-2026.session_token=`;
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(name));
  expect(cookie).toBeDefined();
  for (const attribute of ["Max-Age=604800", "HttpOnly", "SameSite=Lax", "Path=/"])
    expect(cookie).toContain(attribute);
  if (secure) expect(cookie).toContain("; Secure");
  else expect(cookie).not.toContain("; Secure");
  return cookie!;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(issuedAt);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each(paths)("%s は1日境界でDBとCookieを更新し、直前・直後には再更新しない", async (path) => {
  const user = await fixture();
  vi.setSystemTime(issuedAt + day - 1);
  const before = await request(path, user.cookie);
  expect(before.status).toBe(200);
  expect(await sessionRow(user.token)).toEqual({
    expiresAt: issuedAt + 7 * day,
    updatedAt: issuedAt,
  });
  expect(before.headers.getSetCookie()).toEqual([]);
  vi.setSystemTime(issuedAt + day);
  const atBoundary = await request(path, user.cookie);
  expect(atBoundary.status).toBe(200);
  expect(await sessionRow(user.token)).toEqual({
    expiresAt: issuedAt + 8 * day,
    updatedAt: issuedAt + day,
  });
  expect(atBoundary.headers.getSetCookie()).toHaveLength(1);
  expect(cookiePair(sessionCookie(atBoundary))).toBe(user.cookie);
  expect(atBoundary.headers.get("cache-control")).toBe("no-store");
  vi.setSystemTime(issuedAt + day + 1);
  const after = await request(path, user.cookie);
  expect(after.status).toBe(200);
  expect((await sessionRow(user.token))?.expiresAt).toBe(issuedAt + 8 * day);
  expect(after.headers.getSetCookie()).toEqual([]);
});

test("初回更新境界を1ms過ぎたアクセスも更新する", async () => {
  const user = await fixture();
  vi.setSystemTime(issuedAt + day + 1);
  sessionCookie(await request(paths[0]!, user.cookie));
  expect((await sessionRow(user.token))?.expiresAt).toBe(issuedAt + 8 * day + 1);
});

test("通常応答へBetter Authと同じCookieを返し、元の7日期限を越えて認証できる", async () => {
  const user = await fixture();
  vi.setSystemTime(issuedAt + 6 * day);
  const renewed = await request(paths[0]!, user.cookie);
  const cookie = sessionCookie(renewed);
  const browserExpiresAt = Date.now() + Number(/Max-Age=(\d+)/.exec(cookie)![1]) * 1000;
  expect(browserExpiresAt).toBe(issuedAt + 13 * day);
  expect((await sessionRow(user.token))?.expiresAt).toBe(browserExpiresAt);
  // 同じ局面に戻し、ライブラリの生成ヘッダーを正本として完全一致を確認する。
  await env.APP_DB.prepare("UPDATE session SET expiresAt = ?, updatedAt = ? WHERE token = ?")
    .bind(issuedAt + 7 * day, issuedAt, user.token)
    .run();
  const direct = await createAuth(env).api.getSession({
    headers: new Headers({ Cookie: user.cookie }),
    returnHeaders: true,
  });
  expect(renewed.headers.getSetCookie()).toEqual(direct.headers.getSetCookie());
  vi.setSystemTime(issuedAt + 7 * day + 1);
  expect(Date.now()).toBeLessThan(browserExpiresAt);
  expect(await (await request(paths[0]!, cookiePair(cookie))).json()).toMatchObject({
    user: { name: "登録名" },
  });
});

test.each(["none", "tampered", "expired"] as const)(
  "%s は未認証として扱い、期限を延ばさない",
  async (kind) => {
    const user = await fixture();
    vi.setSystemTime(issuedAt + (kind === "expired" ? 7 * day + 1 : day));
    const cookie =
      kind === "none" ? undefined : kind === "tampered" ? `${user.cookie}bad` : user.cookie;
    const response = await request(paths[0]!, cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: null });
    expect((await request(paths[2]!, cookie)).status).toBe(401);
    if (kind === "expired") {
      expect(await sessionRow(user.token)).toBeNull();
      const cookies = response.headers.getSetCookie();
      expect(cookies.length).toBeGreaterThan(0);
      expect(cookies.every((value) => value.includes("Max-Age=0"))).toBe(true);
    } else {
      expect((await sessionRow(user.token))?.expiresAt).toBe(issuedAt + 7 * day);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  },
);

test("DB認証障害は503として返し、未認証への降格やCookie発行をしない", async () => {
  const user = await fixture();
  vi.setSystemTime(issuedAt + day);
  const broken = {
    ...env,
    APP_DB: {
      prepare: () => {
        throw new Error("Session DB unavailable");
      },
      batch: env.APP_DB.batch.bind(env.APP_DB),
      exec: env.APP_DB.exec.bind(env.APP_DB),
    } as unknown as D1Database,
  };
  for (const path of [paths[0]!, paths[2]!]) {
    const response = await request(path, user.cookie, {}, broken);
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  }
  expect((await sessionRow(user.token))?.expiresAt).toBe(issuedAt + 7 * day);
});

test("セッション更新後のプロフィールDB障害でも503応答へ更新Cookieを引き継ぐ", async () => {
  const user = await fixture();
  vi.setSystemTime(issuedAt + day);
  const broken = {
    ...env,
    APP_DB: {
      prepare: (sql: string) => {
        if (sql.startsWith("SELECT id, name, username")) throw new Error("Profile DB unavailable");
        return env.APP_DB.prepare(sql);
      },
      batch: env.APP_DB.batch.bind(env.APP_DB),
      exec: env.APP_DB.exec.bind(env.APP_DB),
    } as unknown as D1Database,
  };
  const response = await request(paths[0]!, user.cookie, {}, broken);
  expect(response.status).toBe(503);
  sessionCookie(response);
  expect((await sessionRow(user.token))?.expiresAt).toBe(issuedAt + 8 * day);
});

test("フィードバックCookie・古いキャッシュCookie削除・更新Cookieを別々に保持する", async () => {
  const user = await fixture();
  vi.setSystemTime(issuedAt + day);
  const body = new FormData();
  body.set(
    "input",
    JSON.stringify({
      submissionId: crypto.randomUUID(),
      kind: "bug",
      game: "four-reversi",
      body: "セッション更新の確認",
      expectation: "ログインが維持される",
      steps: "マイページを開く",
      technical: null,
    }),
  );
  const response = await request(
    "/api/feedback",
    `${user.cookie}; tetraboard-2026.session_data=stale`,
    {
      method: "POST",
      headers: { Origin: origin },
      body,
    },
  );
  expect(response.status).toBe(201);
  const cookies = response.headers.getSetCookie();
  expect(cookies).toHaveLength(3);
  expect(cookies.filter((value) => value.startsWith("tetraboard-2026.feedback="))).toHaveLength(1);
  expect(cookies.find((value) => value.startsWith("tetraboard-2026.session_data="))).toContain(
    "Max-Age=0",
  );
  expect(cookiePair(sessionCookie(response))).toBe(user.cookie);
  expect(cookies.every((value) => !value.includes(", tetraboard-2026."))).toBe(true);
});

test("バッジ取得・プロフィール変更・ルーム参加エラーでも更新Cookieを返す", async () => {
  for (const kind of ["badge", "profile", "room"] as const) {
    vi.setSystemTime(issuedAt);
    const user = await fixture(kind !== "room");
    vi.setSystemTime(issuedAt + day);
    const path =
      kind === "badge"
        ? "/api/account/badge-notifications/claim"
        : kind === "profile"
          ? "/api/account/profile"
          : "/api/rooms";
    const response = await request(path, user.cookie, {
      method: kind === "profile" ? "PATCH" : "POST",
      headers: {
        Origin: origin,
        ...(kind === "profile" ? {} : { "Content-Type": "application/json" }),
      },
      body:
        kind === "profile"
          ? new FormData()
          : JSON.stringify(
              kind === "badge"
                ? { token: crypto.randomUUID() }
                : { quickPlay: false, mode: "singles" },
            ),
    });
    expect(response.status).toBe(kind === "badge" ? 200 : kind === "profile" ? 400 : 403);
    sessionCookie(response);
  }
});

test.each([true, false])(
  "管理APIと管理画面の権限判定後にも更新Cookieを返す（管理者=%s）",
  async (allowed) => {
    for (const path of ["/api/admin/session", "/admin"]) {
      vi.setSystemTime(issuedAt);
      const user = await fixture();
      vi.setSystemTime(issuedAt + day);
      const bindings: AdminEnv = {
        ...env,
        ADMIN_ACCOUNT_ID: allowed ? user.id : "another-admin",
        ADMIN_ACCOUNT_IDS: JSON.stringify([allowed ? user.id : "another-admin"]),
        ASSETS: {
          fetch: async () => new Response("admin asset", { headers: { ETag: '"admin"' } }),
        } as unknown as Fetcher,
      };
      const response = await request(path, user.cookie, {}, bindings);
      expect(response.status).toBe(allowed ? 200 : 403);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      sessionCookie(response);
      if (allowed && path === "/admin") {
        expect(await response.text()).toBe("admin asset");
        expect(response.headers.get("ETag")).toBe('"admin"');
      }
    }
  },
);

test("HTTPSではSecureとCookie名を維持し、失効した管理画面の転送にも削除Cookieを返す", async () => {
  const user = await fixture();
  const cookie = `__Secure-${user.cookie}`;
  const bindings: AdminEnv = {
    ...env,
    APP_ORIGIN: "https://tetraboard.net",
    ADMIN_ACCOUNT_ID: user.id,
    ADMIN_ACCOUNT_IDS: JSON.stringify([user.id]),
    ASSETS: { fetch: async () => new Response("admin") } as unknown as Fetcher,
  };
  vi.setSystemTime(issuedAt + day);
  const response = await request(paths[0]!, cookie, {}, bindings);
  expect(response.status).toBe(200);
  expect(cookiePair(sessionCookie(response, true))).toBe(cookie);
  vi.setSystemTime(issuedAt + 8 * day + 1);
  const expired = await request("/admin", cookie, {}, bindings);
  expect(expired.status).toBe(302);
  expect(expired.headers.get("Location")).toBe(`${bindings.APP_ORIGIN}/login?destination=admin`);
  const cookies = expired.headers.getSetCookie();
  expect(cookies.length).toBeGreaterThan(0);
  expect(cookies.every((value) => value.includes("Max-Age=0") && value.includes("Secure"))).toBe(
    true,
  );
});

test("並行した別アカウントと未認証の応答へCookieを混ぜない", async () => {
  const users = await Promise.all([fixture(), fixture()]);
  vi.setSystemTime(issuedAt + day);
  const responses = await Promise.all([
    ...users.map((user) => request(paths[0]!, user.cookie)),
    request(paths[0]!),
  ]);
  for (const [index, user] of users.entries()) {
    expect(responses[index]!.headers.getSetCookie()).toHaveLength(1);
    expect(cookiePair(sessionCookie(responses[index]!))).toBe(user.cookie);
  }
  expect(responses[2]!.headers.getSetCookie()).toEqual([]);
});

test("計測APIとルーム作成の成功応答にも更新Cookieを返す", async () => {
  for (const kind of ["analytics", "room"] as const) {
    vi.setSystemTime(issuedAt);
    const user = await fixture();
    vi.setSystemTime(issuedAt + day);
    const response = await request(
      kind === "analytics" ? "/api/analytics/pageviews" : "/api/rooms",
      `${user.cookie}; tetraboard-2026.analytics=${crypto.randomUUID()}`,
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(
          kind === "analytics"
            ? { id: crypto.randomUUID(), page: "lobby", game: "four-reversi" }
            : { quickPlay: false, mode: "singles" },
        ),
      },
    );
    expect(response.status).toBe(kind === "analytics" ? 204 : 201);
    sessionCookie(response);
    if (kind === "room") {
      const created = (await response.json()) as {
        room: { id: string };
        membership: { token: string };
      };
      await request(`/api/rooms/${created.room.id}/leave`, undefined, {
        method: "POST",
        headers: { Authorization: `Bearer ${created.membership.token}` },
      });
    }
  }
});

test("既存の複数CookieにExpiresのカンマがあっても欠落・結合させない", async () => {
  const user = await fixture();
  vi.setSystemTime(issuedAt + day);
  const req = new Request(origin, { headers: { Cookie: user.cookie } });
  const existing = [
    "visitor=first; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Path=/; HttpOnly",
    "preference=second; Expires=Wed, 02 Jan 2030 00:00:00 GMT; Path=/; SameSite=Lax",
  ];
  const response = await withAccountSessionCookies(req, async () => {
    await accountIdentity(req, env);
    const headers = new Headers({ "Content-Type": "text/plain" });
    for (const cookie of existing) headers.append("Set-Cookie", cookie);
    return new Response("body", { status: 202, headers });
  });
  expect(response.headers.getSetCookie()).toHaveLength(3);
  expect(response.headers.getSetCookie().slice(0, 2)).toEqual(existing);
  sessionCookie(response);
  expect(response.status).toBe(202);
  expect(await response.text()).toBe("body");
});

test("変更不可の応答ヘッダーとWebSocketを保持し、例外終了後はCookieを破棄する", async () => {
  const user = await fixture();
  vi.setSystemTime(issuedAt + day);
  const req = new Request(origin, { headers: { Cookie: user.cookie } });
  await expect(
    withAccountSessionCookies(req, async () => {
      await accountIdentity(req, env);
      throw new Error("Handler failed");
    }),
  ).rejects.toThrow("Handler failed");
  const clean = await withAccountSessionCookies(req, async () => Response.redirect(origin));
  expect(clean.status).toBe(302);
  expect(clean.headers.getSetCookie()).toEqual([]);
  vi.setSystemTime(issuedAt + 2 * day);
  const pair = new WebSocketPair();
  pair[1].accept();
  const upgraded = await withAccountSessionCookies(req, async () => {
    await accountIdentity(req, env);
    return new Response(null, { status: 101, webSocket: pair[0] });
  });
  expect(upgraded.status).toBe(101);
  expect(upgraded.webSocket).toBe(pair[0]);
  sessionCookie(upgraded);
  pair[1].close(1000);
  vi.setSystemTime(issuedAt + 3 * day);
  const redirected = await withAccountSessionCookies(req, async () => {
    await accountIdentity(req, env);
    return Response.redirect(origin, 307);
  });
  expect(redirected.status).toBe(307);
  expect(redirected.headers.get("Location")).toBe(`${origin}/`);
  sessionCookie(redirected);
});
