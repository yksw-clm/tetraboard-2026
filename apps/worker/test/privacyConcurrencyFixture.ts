import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, onTestFinished } from "vitest";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";

// 再認証とCookieの検証で、共有DBに残る退会ジョブや全ルームを巡回しません。
export async function privacyConcurrencyFixture() {
  const db = (env as typeof env & { PRIVACY_CONCURRENCY_TEST_DB: D1Database })
    .PRIVACY_CONCURRENCY_TEST_DB;
  await applyD1Migrations(
    db,
    (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  );
  const bindings = { ...env, APP_DB: db };
  return {
    db,
    accountFixture: () => accountFixture(true, crypto.randomUUID(), db),
    request: async (path: string, init?: RequestInit) => {
      const context = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${origin}/api${path}`, { redirect: "manual", ...init }),
        bindings,
        context,
      );
      await waitOnExecutionContext(context);
      return response;
    },
  };
}

export async function unrelatedDeletionFixture() {
  const id = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES (?,0,?)",
  )
    .bind(id, crypto.randomUUID())
    .run();
  onTestFinished(async () => {
    await env.APP_DB.prepare("DELETE FROM deleted_accounts WHERE id=?").bind(id).run();
  });
  return async () => {
    expect(
      await env.APP_DB.prepare(
        "SELECT last_attempted_at_ms,completed_at_ms FROM deleted_accounts WHERE id=?",
      )
        .bind(id)
        .first(),
    ).toEqual({ last_attempted_at_ms: 0, completed_at_ms: null });
  };
}
