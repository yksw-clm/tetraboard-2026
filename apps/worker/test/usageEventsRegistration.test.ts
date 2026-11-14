import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, test, vi } from "vitest";
import { accountFixture } from "./accountFixtures";
import { recordUsageEvents } from "./usageEventsRecorder";
import worker from "../src/worker";
import { legalVersion } from "@tetraboard/protocol/privacy";
import {
  recordRegistrationOAuthStart,
  writeRegistrationCompletionUsage,
  writeProfileCompletionUsage as recordProfileCompletion,
} from "../src/usageEvents/registration";

const env = {
  ...bindings,
  APP_DB: (bindings as typeof bindings & { ANALYTICS_REGISTRATION_TEST_DB: D1Database })
    .ANALYTICS_REGISTRATION_TEST_DB,
  USAGE_EVENTS: { writeDataPoint() {} } as unknown as AnalyticsEngineDataset,
};
beforeAll(async () =>
  applyD1Migrations(
    env.APP_DB,
    (bindings as typeof bindings & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  ),
);

function completeRegistration(
  request: Request,
  response: Response,
  configured: typeof env,
  newAccount: boolean,
) {
  return writeRegistrationCompletionUsage(configured, request, response, newAccount);
}

function unavailableLegacyReads() {
  return {
    ...env,
    APP_DB: new Proxy(env.APP_DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("analytics")) throw new Error("legacy unavailable");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

test.each([
  { unavailable: false, provider: "google", newAccount: true, isTest: true },
  { unavailable: false, provider: "discord", newAccount: false, isTest: false },
  { unavailable: true, provider: "google", newAccount: false, isTest: true },
  { unavailable: true, provider: "discord", newAccount: true, isTest: false },
])(
  "旧の手続きがなくても完了を要求のブラウザと本人で記録する: %j",
  async ({ unavailable, provider, newAccount, isTest }) => {
    const events = recordUsageEvents();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = await accountFixture(false, crypto.randomUUID(), env.APP_DB);
    await env.APP_DB.prepare("UPDATE user SET isTestUser=? WHERE id=?")
      .bind(Number(isTest), user.id)
      .run();
    const browserId = crypto.randomUUID();
    const request = new Request(
      `${env.APP_ORIGIN}/api/auth/callback/${provider}?state=${crypto.randomUUID()}`,
      {
        headers: { Cookie: `tetraboard-2026.analytics=${browserId}` },
      },
    );
    const response = new Response(null, {
      status: 302,
      headers: { "Set-Cookie": user.cookie, Location: "/account/setup" },
    });
    const configured = unavailable ? unavailableLegacyReads() : env;
    await completeRegistration(request, response, configured, newAccount);
    await recordProfileCompletion(configured, user.id, request);
    expect(events).toEqual(
      ["oauth_success", newAccount ? "registered" : "existing_login", "profile_complete"].map(
        (stage) => ({
          name: "registration",
          stage,
          flowId: null,
          entry: "unknown",
          game: null,
          browserId,
          accountId: user.id,
          isTest,
        }),
      ),
    );
  },
);

test.each([undefined, "not-a-uuid"])(
  "完了のブラウザIDはUUIDの計測Cookieがなければ空になる: %s",
  async (cookie) => {
    const events = recordUsageEvents();
    const user = await accountFixture(false, crypto.randomUUID(), env.APP_DB);
    const request = new Request(
      `${env.APP_ORIGIN}/api/auth/callback/google?state=${crypto.randomUUID()}`,
      {
        headers: cookie ? { Cookie: `tetraboard-2026.analytics=${cookie}` } : {},
      },
    );
    await completeRegistration(
      request,
      new Response(null, { status: 302, headers: { "Set-Cookie": user.cookie } }),
      env,
      true,
    );
    await recordProfileCompletion(env, user.id, request);
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.browserId === null)).toBe(true);
  },
);

test.each(["guest", "deleted"])(
  "ゲストと退会済みの完了は新イベントに書かない: %s",
  async (kind) => {
    const events = recordUsageEvents();
    const user = await accountFixture(false, crypto.randomUUID(), env.APP_DB);
    if (kind === "guest")
      await env.APP_DB.prepare("UPDATE user SET isAnonymous=1 WHERE id=?").bind(user.id).run();
    else
      await env.APP_DB.prepare(
        "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,?,?)",
      )
        .bind(user.id, Date.now(), crypto.randomUUID())
        .run();
    const request = new Request(
      `${env.APP_ORIGIN}/api/auth/callback/google?state=${crypto.randomUUID()}`,
    );
    await completeRegistration(
      request,
      new Response(null, { status: 302, headers: { "Set-Cookie": user.cookie } }),
      env,
      true,
    );
    await recordProfileCompletion(env, user.id, request);
    expect(events).toEqual([]);
  },
);

test.each([
  { path: "/google", search: "", status: 302, destination: "/account", cookie: "valid" },
  {
    path: "/google",
    search: "?state=s&error=denied",
    status: 302,
    destination: "/account",
    cookie: "valid",
  },
  { path: "/google", search: "?state=s", status: 400, destination: "/account", cookie: "valid" },
  { path: "/google", search: "?state=s", status: 302, destination: "/account", cookie: "missing" },
  {
    path: "/google",
    search: "?state=s",
    status: 302,
    destination: "/account?error=denied",
    cookie: "valid",
  },
  {
    path: "/google",
    search: "?state=s",
    status: 302,
    destination: "/account/deletion",
    cookie: "valid",
  },
  { path: "/other", search: "?state=s", status: 302, destination: "/account", cookie: "valid" },
  { path: "/google", search: "?state=s", status: 302, destination: "/account", cookie: "invalid" },
])(
  "OAuth成功の条件を満たさない応答では新イベントを書かない: %j",
  async ({ path, search, status, destination, cookie }) => {
    const events = recordUsageEvents();
    const user = await accountFixture(false, crypto.randomUUID(), env.APP_DB);
    await completeRegistration(
      new Request(`${env.APP_ORIGIN}/api/auth/callback${path}${search}`),
      new Response(null, {
        status,
        headers: {
          Location: destination,
          ...(cookie === "missing"
            ? {}
            : { "Set-Cookie": cookie === "valid" ? user.cookie : `${user.cookie}tampered` }),
        },
      }),
      env,
      true,
    );
    expect(events).toEqual([]);
  },
);

test("旧テーブルを読めなくても設定APIからプロフィール完了に要求のブラウザを渡す", async () => {
  const events = recordUsageEvents();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const user = await accountFixture(false, crypto.randomUUID(), env.APP_DB);
  await env.APP_DB.prepare("UPDATE user SET isTestUser=1 WHERE id=?").bind(user.id).run();
  const browserId = crypto.randomUUID();
  const form = new FormData();
  form.set("name", "設定成功");
  form.set("username", `track_${user.id.slice(0, 8)}`);
  form.set("avatarAction", "keep");
  form.set("consentVersion", legalVersion);
  const response = await worker.fetch(
    new Request(`${env.APP_ORIGIN}/api/account/setup`, {
      method: "POST",
      headers: {
        Cookie: `${user.cookie}; tetraboard-2026.analytics=${browserId}`,
        Origin: env.APP_ORIGIN,
      },
      body: form,
    }),
    unavailableLegacyReads(),
    { waitUntil() {} } as unknown as ExecutionContext,
  );
  expect(response.status).toBe(200);
  expect(events).toEqual([
    {
      name: "registration",
      stage: "profile_complete",
      flowId: null,
      entry: "unknown",
      game: null,
      browserId,
      accountId: user.id,
      isTest: true,
    },
  ]);
});

test.each(["write", "context"])("新イベントの障害は完了処理へ伝播しない: %s", async (failure) => {
  recordUsageEvents(failure === "write");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const user = await accountFixture(false, crypto.randomUUID(), env.APP_DB);
  const configured =
    failure === "write"
      ? env
      : {
          ...env,
          APP_DB: new Proxy(env.APP_DB, {
            get(target, key) {
              if (key === "prepare")
                return (sql: string) => {
                  if (sql.startsWith("SELECT isTestUser FROM user"))
                    throw new Error("context unavailable");
                  return target.prepare(sql);
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        };
  const request = new Request(`${env.APP_ORIGIN}/api/auth/callback/google?state=success`);
  await expect(
    completeRegistration(
      request,
      new Response(null, {
        status: 302,
        headers: { "Set-Cookie": user.cookie },
      }),
      configured,
      true,
    ),
  ).resolves.toBeUndefined();
  await expect(recordProfileCompletion(configured, user.id, request)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalled();
});

test("OAuth開始は手続き・ブラウザ・本人の情報で新イベントだけを書く", async () => {
  const events = recordUsageEvents();
  const user = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  await env.APP_DB.prepare("UPDATE user SET isTestUser=1 WHERE id=?").bind(user.id).run();
  const input = { id: crypto.randomUUID(), entry: "room-result" as const, game: "shogi" as const };
  const browserId = crypto.randomUUID();
  await recordRegistrationOAuthStart(
    new Request(env.APP_ORIGIN, {
      headers: { Cookie: `${user.cookie}; tetraboard-2026.analytics=${browserId}` },
    }),
    unavailableLegacyReads(),
    input,
  );
  expect(events).toEqual([
    {
      name: "registration",
      flowId: input.id,
      entry: "room-result",
      game: "shogi",
      browserId,
      accountId: user.id,
      isTest: true,
      stage: "oauth_start",
    },
  ]);
});

test.each(["", "/api"])("登録入口%sはD1なしで204とentryだけを記録する", async (prefix) => {
  const points: import("../src/usageEvents/events").UsageDataPoint[] = [];
  const browserId = crypto.randomUUID();
  const input = { id: crypto.randomUUID(), entry: "login-page", game: "shogi" };
  const dbRead = vi.fn(() => {
    throw new Error("D1 must not be accessed");
  });
  const response = await worker.fetch(
    new Request(`${env.APP_ORIGIN}${prefix}/analytics/registration`, {
      method: "POST",
      headers: {
        Origin: env.APP_ORIGIN,
        Cookie: `tetraboard-2026.analytics=${browserId}; tetraboard-2026.session_token=unused`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }),
    {
      ...env,
      APP_DB: new Proxy(env.APP_DB, { get: dbRead }),
      USAGE_EVENTS: {
        writeDataPoint(point: import("../src/usageEvents/events").UsageDataPoint) {
          points.push(point);
        },
      },
    } as typeof env,
    {} as ExecutionContext,
  );
  expect(response.status).toBe(204);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(dbRead).not.toHaveBeenCalled();
  expect(points).toEqual([
    {
      indexes: ["registration"],
      blobs: ["registration", "0", "shogi", browserId, "", input.id, "entry", "login-page"],
      doubles: [],
    },
  ]);
});

test.each([
  { body: "{", status: 400 },
  { body: JSON.stringify({ id: "invalid", entry: "login-page", game: null }), status: 400 },
  {
    body: JSON.stringify({ id: crypto.randomUUID(), entry: "arbitrary", game: null }),
    status: 400,
  },
  { extra: { stage: "registered" }, status: 400 },
  { extra: { accountId: "spoofed" }, status: 400 },
  { origin: "https://other.example", status: 403 },
  { origin: "", status: 403 },
  { origin: "null", status: 403 },
])("登録入口は不正な本文とOriginを拒否する: %j", async ({ body, extra, origin, status }) => {
  const write = vi.fn();
  const response = await worker.fetch(
    new Request(`${env.APP_ORIGIN}/api/analytics/registration`, {
      method: "POST",
      headers: {
        ...(origin === "" ? {} : { Origin: origin ?? env.APP_ORIGIN }),
        "Content-Type": "application/json",
      },
      body:
        body ??
        JSON.stringify({ id: crypto.randomUUID(), entry: "login-page", game: null, ...extra }),
    }),
    { ...env, USAGE_EVENTS: { writeDataPoint: write } } as unknown as typeof env,
    {} as ExecutionContext,
  );
  expect(response.status).toBe(status);
  expect(write).not.toHaveBeenCalled();
});

test.each([false, true])("登録入口はCookieなし・計測書き込み失敗=%sでも204を返す", async (fail) => {
  const write = vi.fn(() => {
    if (fail) throw new Error("unavailable");
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const response = await worker.fetch(
    new Request(`${env.APP_ORIGIN}/api/analytics/registration`, {
      method: "POST",
      headers: { Origin: env.APP_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), entry: "login-page", game: null }),
    }),
    { ...env, USAGE_EVENTS: { writeDataPoint: write } } as unknown as typeof env,
    {} as ExecutionContext,
  );
  expect(response.status).toBe(204);
  expect(write).toHaveBeenCalledTimes(1);
});
