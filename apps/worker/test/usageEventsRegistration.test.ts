import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, test, vi } from "vitest";
import { accountFixture } from "./accountFixtures";
import { recordUsageEvents } from "./usageEventsRecorder";
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
    const callback = new Request(`${env.APP_ORIGIN}/api/auth/callback/google?state=${state}`);
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
        flowId: input.id,
        entry: "login-page",
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
      await recordProfileCompletion(env, user.id);
      expect(events.at(-1)).toEqual({
        name: "registration",
        stage: "profile_complete",
        flowId: input.id,
        entry: "login-page",
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
