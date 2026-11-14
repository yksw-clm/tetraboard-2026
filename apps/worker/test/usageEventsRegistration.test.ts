import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, test, vi } from "vitest";
import { accountFixture } from "./accountFixtures";
import { recordUsageEvents } from "./usageEventsRecorder";
import worker from "../src/worker";
import { legalVersion } from "@tetraboard/protocol/privacy";
import {
  recordRegistrationEntry,
  rememberRegistrationAnalytics,
  completeRegistrationAnalytics,
  recordProfileCompletion,
} from "../src/analytics/registration";

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

function unavailableWrites() {
  return {
    ...env,
    APP_DB: new Proxy(env.APP_DB, {
      get(target, key) {
        if (key === "batch")
          return () => {
            throw new Error("legacy unavailable");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

function unavailableLegacyReads() {
  return {
    ...env,
    APP_DB: new Proxy(env.APP_DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (/analytics_registration_/.test(sql)) throw new Error("legacy unavailable");
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
    await completeRegistrationAnalytics(request, response, configured, newAccount);
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
    expect(
      await env.APP_DB.prepare(
        "SELECT 1 FROM analytics_registration_flows WHERE target_account_id=?",
      )
        .bind(user.id)
        .first(),
    ).toBeNull();
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
    await completeRegistrationAnalytics(
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
    await completeRegistrationAnalytics(
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
    await completeRegistrationAnalytics(
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

test.each(["write", "context"])(
  "新イベントの障害でも旧のOAuth完了とプロフィール完了を保存する: %s",
  async (failure) => {
    recordUsageEvents(failure === "write");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = await accountFixture(false, crypto.randomUUID(), env.APP_DB);
    const input = { id: crypto.randomUUID(), entry: "login-page" as const, game: null };
    const state = crypto.randomUUID();
    await rememberRegistrationAnalytics(new Request(env.APP_ORIGIN), env, state, "google", input);
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
    const request = new Request(`${env.APP_ORIGIN}/api/auth/callback/google?state=${state}`);
    await completeRegistrationAnalytics(
      request,
      new Response(null, { status: 302, headers: { "Set-Cookie": user.cookie } }),
      configured,
      true,
    );
    await recordProfileCompletion(configured, user.id, request);
    const saved = await env.APP_DB.prepare(
      "SELECT stage FROM analytics_registration_events WHERE flow_id=? ORDER BY stage",
    )
      .bind(input.id)
      .all<{ stage: string }>();
    expect(saved.results.map((r) => r.stage)).toEqual([
      "entry",
      "oauth_start",
      "oauth_success",
      "profile_complete",
      "profile_required",
      "registered",
    ]);
  },
);

test("旧D1の入口・OAuth開始の書き込みが失敗しても、新イベントに手続きと本人を残す", async () => {
  const events = recordUsageEvents();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const user = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  await env.APP_DB.prepare("UPDATE user SET isTestUser=1 WHERE id=?").bind(user.id).run();
  const input = { id: crypto.randomUUID(), entry: "room-result" as const, game: "shogi" as const };
  const browserId = crypto.randomUUID();
  await expect(
    recordRegistrationEntry(unavailableWrites(), input, browserId, null),
  ).rejects.toThrow();
  await rememberRegistrationAnalytics(
    new Request(env.APP_ORIGIN, {
      headers: { Cookie: `${user.cookie}; tetraboard-2026.analytics=${browserId}` },
    }),
    unavailableWrites(),
    crypto.randomUUID(),
    "google",
    input,
  );
  expect(events).toEqual([
    {
      name: "registration",
      flowId: input.id,
      entry: "room-result",
      game: "shogi",
      browserId,
      accountId: undefined,
      isTest: false,
      stage: "entry",
    },
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

test.each([true, false])(
  "OAuth完了は旧D1の保存失敗でも成功・登録区分を記録する（新規=%s）",
  async (newAccount) => {
    const events = recordUsageEvents();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const user = await accountFixture(false, crypto.randomUUID(), env.APP_DB);
    const input = { id: crypto.randomUUID(), entry: "login-page" as const, game: null };
    const browserId = crypto.randomUUID(),
      state = crypto.randomUUID();
    await rememberRegistrationAnalytics(
      new Request(env.APP_ORIGIN, {
        headers: { Cookie: `tetraboard-2026.analytics=${browserId}` },
      }),
      env,
      state,
      "google",
      input,
    );
    const callback = new Request(`${env.APP_ORIGIN}/api/auth/callback/google?state=${state}`, {
      headers: { Cookie: `tetraboard-2026.analytics=${browserId}` },
    });
    const response = new Response(null, {
      status: 302,
      headers: { "Set-Cookie": user.cookie, Location: "/account/setup" },
    });
    await completeRegistrationAnalytics(callback, response, unavailableWrites(), newAccount);
    expect(events.filter((e) => e.name === "registration").map((e) => e.stage)).toEqual([
      "oauth_start",
      "oauth_success",
      newAccount ? "registered" : "existing_login",
    ]);
    for (const event of events.slice(1))
      expect(event).toMatchObject({
        flowId: null,
        entry: "unknown",
        game: null,
        browserId,
        accountId: user.id,
        isTest: false,
      });
    // 成功応答を残した旧保存待ちを再送し、プロフィール完了の帰属を用意します。
    await completeRegistrationAnalytics(callback, response, env, newAccount);
    await env.APP_DB.exec(
      "CREATE TRIGGER usage_fail_profile BEFORE INSERT ON analytics_registration_events WHEN NEW.stage='profile_complete' BEGIN SELECT RAISE(ABORT,'unavailable'); END",
    );
    try {
      await recordProfileCompletion(env, user.id, callback);
      expect(events.at(-1)).toEqual({
        name: "registration",
        stage: "profile_complete",
        flowId: null,
        entry: "unknown",
        game: null,
        browserId,
        accountId: user.id,
        isTest: false,
      });
      expect(
        await env.APP_DB.prepare(
          "SELECT 1 FROM analytics_registration_events WHERE flow_id=? AND stage='profile_complete'",
        )
          .bind(input.id)
          .first(),
      ).toBeNull();
    } finally {
      await env.APP_DB.exec("DROP TRIGGER usage_fail_profile");
    }
  },
);
