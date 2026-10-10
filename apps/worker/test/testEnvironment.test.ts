import { env } from "cloudflare:workers";
import { expect, expectTypeOf, test } from "vitest";

test("Workerの設定は開発用ファイルやプロセス環境変数から取り込まない", () => {
  expect(env).toMatchObject({
    APP_ORIGIN: "http://localhost:5173",
    MODERATOR_TOKEN: "test-moderator-token",
    FEEDBACK_HASH_SECRET: "feedback-test-only-secret-at-least-32-characters",
    BETTER_AUTH_SECRET: "tetraboard-local-only-secret-at-least-32-characters",
    GOOGLE_CLIENT_ID: "test-google",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    DISCORD_CLIENT_ID: "test-discord",
    DISCORD_CLIENT_SECRET: "test-discord-secret",
  });
  expect(env).not.toHaveProperty("ADMIN_ACCOUNT_ID");
  expect(env).not.toHaveProperty("ADMIN_ACCOUNT_IDS");
  for (const key of [
    "TETRABOARD_DEV_VARS_LEAK",
    "TETRABOARD_DOT_ENV_LEAK",
    "TETRABOARD_PROCESS_ENV_LEAK",
  ]) {
    expect(env).not.toHaveProperty(key);
  }
});

test("生成した型は設定例のキーを含み、個人設定の追加キーを含まない", () => {
  expectTypeOf<Env>().toHaveProperty("ADMIN_ACCOUNT_IDS");
  expectTypeOf<Env>().toHaveProperty("FEEDBACK_HASH_SECRET");
  expectTypeOf<Env>().not.toHaveProperty("TETRABOARD_DEV_VARS_LEAK");
  expectTypeOf<Env>().not.toHaveProperty("TETRABOARD_DOT_ENV_LEAK");
  expectTypeOf<Env>().not.toHaveProperty("TETRABOARD_PROCESS_ENV_LEAK");
});
