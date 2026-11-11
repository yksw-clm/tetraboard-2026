import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { readAnalytics } from "../src/admin/metrics";
import worker from "../src/worker";
import { recordLoginUsage } from "../src/accounts/loginUsage";
import { accountSessionIdentity } from "../src/accounts/auth";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import {
  aggregateAnalytics,
  backfillAccountTotals,
  readAnalyticsFoundation,
} from "../src/analytics/foundation";
import { accountFixture } from "./accountFixtures";
import { recordAccountUsage, accountUsageStatement } from "../src/accounts/usage";
import { archiveAnalytics } from "../src/analytics/retention";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";

const env = {
  ...bindings,
  APP_DB: (bindings as typeof bindings & { ANALYTICS_FOUNDATION_TEST_DB: D1Database })
    .ANALYTICS_FOUNDATION_TEST_DB,
};
beforeAll(async () => {
  await applyD1Migrations(
    env.APP_DB,
    (bindings as typeof bindings & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  );
});

// 修正前はarchiveAnalyticsのINSERT・DELETEが観測されて失敗します。
test("管理データの取得は集約・削除を実行しない", async () => {
  const writes: string[] = [];
  const db = new Proxy(env.APP_DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (
            /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|sqlite_master|pragma_table_info)\b/i.test(
              sql,
            )
          )
            writes.push(sql.split("\n")[0]!);
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  await readAnalytics(
    { ...env, APP_DB: db },
    {
      from: "2026-11-11",
      to: "2026-11-11",
      game: "all",
      bucket: "day",
      includeInternal: "true",
    },
  );

  expect(writes).toEqual([]);
});

// 修正前は毎時保守の資格削除が走り、残すべき資格が消えて失敗します。
test("5分の分析ジョブは毎時の資格削除を実行しない", async () => {
  const id = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,1,1,1)",
  )
    .bind(id, id, "expired")
    .run();

  await worker.scheduled({ cron: "*/5 * * * *" } as ScheduledController, env);

  expect(
    await env.APP_DB.prepare("SELECT value FROM verification WHERE id=?").bind(id).first("value"),
  ).toBe("expired");
});

const query = {
  from: "2026-11-01",
  to: "2026-11-30",
  game: "all",
  bucket: "day",
  includeInternal: "true",
} as const;
const now = Date.parse("2026-11-11T12:00:00+09:00");
async function resetFoundation() {
  await env.APP_DB.batch([
    env.APP_DB.prepare("DELETE FROM analytics_dwell"),
    env.APP_DB.prepare("DELETE FROM analytics_pageviews"),
    env.APP_DB.prepare("DELETE FROM analytics_participants"),
    env.APP_DB.prepare("DELETE FROM analytics_matches"),
    env.APP_DB.prepare("DELETE FROM analytics_daily_v2"),
    env.APP_DB.prepare("DELETE FROM analytics_foundation_archive"),
    env.APP_DB.prepare("DELETE FROM analytics_dirty_days"),
    env.APP_DB.prepare(
      "UPDATE analytics_foundation_state SET collected_from_ms=?,aggregated_at_ms=NULL WHERE id=1",
    ).bind(Date.parse("2026-11-01T00:00:00+09:00")),
  ]);
}
async function view(
  at: number,
  account: string | null = null,
  game = "reversi",
  visitor = crypto.randomUUID(),
) {
  const id = crypto.randomUUID();
  await env.APP_DB.prepare(
    "INSERT INTO analytics_pageviews(id,visitor_id,account_id,page,game,started_at_ms) VALUES(?,?,?,'lobby',?,?)",
  )
    .bind(id, visitor, account, game, at)
    .run();
  return id;
}

test("変更日だけを集計し、人数はゲーム横断で重複排除し、再実行で加算しない", async () => {
  await resetFoundation();
  const visitor = crypto.randomUUID();
  const first = await view(now, null, "reversi", visitor);
  await view(now, null, "shogi", visitor);
  await env.APP_DB.prepare("INSERT INTO analytics_dwell VALUES(?,'2026-11-11',1000)")
    .bind(first)
    .run();
  await aggregateAnalytics(env, now);
  const result = await readAnalyticsFoundation(env, query, now);
  expect(result).toMatchObject({
    status: "ready",
    aggregatedAtMs: now,
    metricVersion: 1,
    days: [{ day: "2026-11-11", pageViews: 2, visitors: 1, dwellMs: 1000 }],
  });
  await aggregateAnalytics(env, now + 1);
  expect((await readAnalyticsFoundation(env, query, now + 1)).days).toEqual(result.days);
  const writes: string[] = [];
  await aggregateAnalytics({ ...env, APP_DB: observedDb(writes) }, now + 2);
  expect(writes.some((sql) => sql.includes("INSERT INTO analytics_daily_v2"))).toBe(false);
  expect((await readAnalyticsFoundation(env, query, now + 300003)).status).toBe("delayed");
  expect((await readAnalyticsFoundation(env, { ...query, to: "2026-11-10" }, now)).days).toEqual(
    [],
  );
});

function observedDb(sqls: string[], beforeBatch?: () => Promise<void>) {
  return new Proxy(env.APP_DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          sqls.push(sql);
          return target.prepare(sql);
        };
      if (key === "batch" && beforeBatch)
        return async (statements: D1PreparedStatement[]) => {
          await beforeBatch();
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("集計途中の失敗は公開値・処理位置を戻し、同時変更は次の集計へ残す", async () => {
  await resetFoundation();
  await view(now);
  await aggregateAnalytics(env, now);
  await view(now + 1);
  const failed = observedDb([], async () => {
    throw new Error("unavailable");
  });
  await expect(aggregateAnalytics({ ...env, APP_DB: failed }, now + 1)).rejects.toThrow(
    "unavailable",
  );
  expect(await readAnalyticsFoundation(env, query, now + 1)).toMatchObject({
    aggregatedAtMs: now,
    days: [{ pageViews: 1 }],
  });
  await aggregateAnalytics(
    { ...env, APP_DB: observedDb([], () => view(now + 2).then(() => {})) },
    now + 2,
  );
  expect((await readAnalyticsFoundation(env, query, now + 2)).aggregatedAtMs).toBe(now);
  await aggregateAnalytics(env, now + 3);
  expect(await readAnalyticsFoundation(env, query, now + 3)).toMatchObject({
    aggregatedAtMs: now + 3,
    days: [{ pageViews: 3 }],
  });
  const db = observedDb([]);
  const original = db.batch.bind(db);
  const broken = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return (statements: D1PreparedStatement[]) =>
          original([...statements, env.APP_DB.prepare("SELECT * FROM missing_foundation_table")]);
      return Reflect.get(target, key);
    },
  });
  await view(now + 4);
  await expect(aggregateAnalytics({ ...env, APP_DB: broken }, now + 4)).rejects.toThrow();
  expect(await readAnalyticsFoundation(env, query, now + 4)).toMatchObject({
    aggregatedAtMs: now + 3,
    days: [{ pageViews: 3 }],
  });
  await aggregateAnalytics(env, now + 5);
  expect((await readAnalyticsFoundation(env, query, now + 5)).days[0]?.pageViews).toBe(4);
});

test("本人の対局数は完了棋譜から再開可能に復元し、履歴移動・退会・遅延保存で整合する", async () => {
  const owner = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const other = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const match = crypto.randomUUID();
  await env.APP_DB.batch([
    env.APP_DB.prepare("INSERT INTO matches VALUES(?,'reversi','singles',?,?,'{}')").bind(
      match,
      now - 60000,
      now,
    ),
    env.APP_DB.prepare(
      "INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms,game) VALUES(?,?,'singles',?,'reversi')",
    ).bind(owner.id, match, now - 60000),
    env.APP_DB.prepare(
      "UPDATE analytics_foundation_state SET backfill_complete=0,backfill_cursor='' WHERE id=1",
    ),
  ]);
  await backfillAccountTotals(env.APP_DB, 1);
  await backfillAccountTotals(env.APP_DB, 100);
  await backfillAccountTotals(env.APP_DB, 100);
  expect(
    await env.APP_DB.prepare(
      "SELECT completed,first_completed_at_ms FROM account_game_totals WHERE account_id=?",
    )
      .bind(owner.id)
      .first(),
  ).toEqual({ completed: 1, first_completed_at_ms: now });
  await env.APP_DB.prepare(
    "INSERT OR IGNORE INTO account_match_history(account_id,match_id,mode,started_at_ms,game) VALUES(?,?,'singles',?,'reversi')",
  )
    .bind(owner.id, match, now - 60000)
    .run();
  await backfillAccountTotals(env.APP_DB);
  expect(
    await env.APP_DB.prepare("SELECT completed FROM account_game_totals WHERE account_id=?")
      .bind(owner.id)
      .first("completed"),
  ).toBe(1);
  await env.APP_DB.prepare("UPDATE account_match_history SET account_id=? WHERE account_id=?")
    .bind(other.id, owner.id)
    .run();
  await backfillAccountTotals(env.APP_DB);
  expect(
    await env.APP_DB.prepare("SELECT completed FROM account_game_totals WHERE account_id=?")
      .bind(other.id)
      .first("completed"),
  ).toBe(1);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM account_game_totals WHERE account_id=?")
      .bind(owner.id)
      .first(),
  ).toBeNull();
  await recordAccountUsage(env.APP_DB, other.id, now);
  await env.APP_DB.prepare(
    "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,?,?)",
  )
    .bind(other.id, now, crypto.randomUUID())
    .run();
  await recordAccountUsage(env.APP_DB, other.id, now + 86400000);
  await env.APP_DB.prepare(
    "INSERT OR IGNORE INTO account_match_history(account_id,match_id,mode,started_at_ms,game) VALUES(?,?,'singles',?,'reversi')",
  )
    .bind(other.id, match, now - 60000)
    .run();
  await backfillAccountTotals(env.APP_DB);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM account_usage WHERE account_id=?")
      .bind(other.id)
      .first(),
  ).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM account_game_totals WHERE account_id=?")
      .bind(other.id)
      .first(),
  ).toBeNull();
});

test("最終利用日はJSTの日付で単調更新し、過去日時を推測で補完しない", async () => {
  await resetFoundation();
  const user = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const at = Date.parse("2026-11-11T23:59:59+09:00");
  await recordAccountUsage(env.APP_DB, user.id, at);
  const result = await accountUsageStatement(env.APP_DB, user.id, at + 1).run();
  expect(result.meta.changes).toBe(0);
  await recordAccountUsage(env.APP_DB, user.id, at + 1000);
  await recordAccountUsage(env.APP_DB, user.id, at);
  expect(
    await env.APP_DB.prepare(
      "SELECT last_login_at_ms,last_used_day FROM account_usage WHERE account_id=?",
    )
      .bind(user.id)
      .first(),
  ).toEqual({ last_login_at_ms: null, last_used_day: "2026-11-12" });
});

test("90日削除と匿名集約を原子的に行い、部分的な日付の遅延結果も失わない", async () => {
  await resetFoundation();
  await view(now);
  await view(now + 3600000);
  const match = crypto.randomUUID();
  await env.APP_DB.batch([
    env.APP_DB.prepare(
      "INSERT INTO analytics_matches VALUES(?,'reversi','singles',?,NULL,'playing',1)",
    ).bind(match, now + 3600000),
    env.APP_DB.prepare(
      "INSERT INTO analytics_participants(match_id,player_id,visitor_id) VALUES(?,'guest',?)",
    ).bind(match, crypto.randomUUID()),
  ]);
  await aggregateAnalytics(env, now);
  const later = now + analyticsRetentionMs;
  await archiveAnalytics(env, later);
  await aggregateAnalytics(env, later + 1);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_pageviews WHERE started_at_ms=?")
      .bind(now)
      .first(),
  ).toBeNull();
  expect((await readAnalyticsFoundation(env, query, later + 1)).days[0]).toMatchObject({
    pageViews: 2,
    visitors: null,
    started: 1,
    completed: 0,
  });
  await env.APP_DB.prepare(
    "UPDATE analytics_matches SET status='completed',ended_at_ms=? WHERE id=?",
  )
    .bind(now + 3601000, match)
    .run();
  await aggregateAnalytics(env, later + 2);
  expect((await readAnalyticsFoundation(env, query, later + 2)).days[0]).toMatchObject({
    pageViews: 2,
    started: 1,
    completed: 1,
  });
  await archiveAnalytics(env, later + 3600001);
  await archiveAnalytics(env, later + 3600001);
  await aggregateAnalytics(env, later + 3600002);
  expect((await readAnalyticsFoundation(env, query, later + 3600002)).days[0]).toMatchObject({
    pageViews: 2,
    started: 1,
    completed: 1,
    completedDurationMs: 1000,
  });
});

test("HTTPとHTTPSのログイン最新値は成功Cookieだけで更新し、再送・失効・セッション確認で増えない", async () => {
  for (const secure of [false, true]) {
    const user = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
    const loginEnv = secure ? { ...env, APP_ORIGIN: "https://tetraboard.net" as const } : env;
    const cookie = secure
      ? user.cookie.replace(
          "tetraboard-2026.session_token=",
          "__Secure-tetraboard-2026.session_token=",
        )
      : user.cookie;
    const request = new Request(
      `${loginEnv.APP_ORIGIN}/api/auth/callback/google?state=${crypto.randomUUID()}`,
    );
    const response = new Response(null, {
      status: 302,
      headers: { "Set-Cookie": `${cookie}; Path=/; HttpOnly` },
    });
    await recordLoginUsage(request, response, loginEnv);
    const login = await env.APP_DB.prepare(
      "SELECT last_login_at_ms FROM account_usage WHERE account_id=?",
    )
      .bind(user.id)
      .first<number>("last_login_at_ms");
    expect(login).toBeGreaterThan(0);
    await recordLoginUsage(request, response, loginEnv);
    await accountSessionIdentity(
      new Request(loginEnv.APP_ORIGIN, { headers: { Cookie: cookie } }),
      loginEnv,
    );
    expect(
      await env.APP_DB.prepare("SELECT last_login_at_ms FROM account_usage WHERE account_id=?")
        .bind(user.id)
        .first("last_login_at_ms"),
    ).toBe(login);
    await env.APP_DB.prepare("DELETE FROM account_usage WHERE account_id=?").bind(user.id).run();
    await recordLoginUsage(request, new Response(null, { status: 302 }), loginEnv);
    await recordLoginUsage(
      request,
      new Response(null, { status: 500, headers: response.headers }),
      loginEnv,
    );
    await recordLoginUsage(
      request,
      new Response(null, { status: 302, headers: { "Set-Cookie": `${cookie}tampered` } }),
      loginEnv,
    );
    await env.APP_DB.prepare("UPDATE session SET expiresAt=1 WHERE userId=?").bind(user.id).run();
    await recordLoginUsage(request, response, loginEnv);
    expect(
      await env.APP_DB.prepare("SELECT 1 FROM account_usage WHERE account_id=?")
        .bind(user.id)
        .first(),
    ).toBeNull();
  }
});

test("ページ閲覧は計測Cookieなしでも本人の利用日を更新し、通知ポーリングは更新しない", async () => {
  const user = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const fetch = (path: string, init: RequestInit = {}) =>
    worker.fetch(
      new AcceptedGameRequest(`http://localhost:5173/api${path}`, {
        ...init,
        headers: {
          Cookie: user.cookie,
          Origin: env.APP_ORIGIN,
          "Content-Type": "application/json",
        },
      }),
      env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
  expect(
    (
      await fetch("/analytics/pageviews", {
        method: "POST",
        body: JSON.stringify({ id: crypto.randomUUID(), page: "account", game: null }),
      })
    ).status,
  ).toBe(204);
  expect(
    await env.APP_DB.prepare("SELECT last_used_day FROM account_usage WHERE account_id=?")
      .bind(user.id)
      .first("last_used_day"),
  ).toBe(new Date(Date.now() + 32400000).toISOString().slice(0, 10));
  await env.APP_DB.prepare("DELETE FROM account_usage WHERE account_id=?").bind(user.id).run();
  await fetch("/account/session");
  await fetch("/account/notifications");
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM account_usage WHERE account_id=?")
      .bind(user.id)
      .first(),
  ).toBeNull();
});

test("一般利用と内部席を区別し、ゲスト統合で過去の対局者を同一人物へまとめない", async () => {
  await resetFoundation();
  const account = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const guest = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const match = crypto.randomUUID();
  await env.APP_DB.batch([
    env.APP_DB.prepare(
      "INSERT INTO analytics_matches VALUES(?,'reversi','singles',?,?, 'playing',0)",
    ).bind(match, now - 60000, null),
    env.APP_DB.prepare(
      "INSERT INTO analytics_participants(match_id,player_id,account_id,is_guest) VALUES(?,'guest',?,1)",
    ).bind(match, guest.id),
    env.APP_DB.prepare(
      "INSERT INTO analytics_participants(match_id,player_id,account_id,is_guest) VALUES(?,'account',?,0)",
    ).bind(match, account.id),
  ]);
  const internal = {
    ...env,
    ADMIN_ACCOUNT_IDS: JSON.stringify([
      account.id,
      ...Array.from({ length: 31 }, () => crypto.randomUUID()),
    ]),
  };
  await aggregateAnalytics(internal, now);
  expect((await readAnalyticsFoundation(env, query, now)).days[0]).toMatchObject({
    started: 1,
    registeredActive: 1,
    guestActive: 1,
  });
  expect(
    (await readAnalyticsFoundation(env, { ...query, includeInternal: "false" }, now)).days[0],
  ).toMatchObject({ started: 1, registeredActive: 0, guestActive: 1 });
  await env.APP_DB.prepare("UPDATE analytics_participants SET account_id=? WHERE account_id=?")
    .bind(account.id, guest.id)
    .run();
  await aggregateAnalytics(env, now + 1);
  expect((await readAnalyticsFoundation(env, query, now + 1)).days[0]).toMatchObject({
    registeredActive: 1,
    guestActive: 1,
  });
  expect(
    await env.APP_DB.prepare(
      "SELECT origin_account_id FROM analytics_participants WHERE match_id=? AND player_id='guest'",
    )
      .bind(match)
      .first("origin_account_id"),
  ).toBe(guest.id);
  await env.APP_DB.prepare(
    "UPDATE analytics_matches SET ended_at_ms=?,status='completed' WHERE id=?",
  )
    .bind(now, match)
    .run();
  await aggregateAnalytics(env, now + 2);
  expect((await readAnalyticsFoundation(env, query, now + 2)).days[0]).toMatchObject({
    started: 1,
    completed: 1,
    completedDurationMs: 60000,
  });
});

test("本人切替後に元のビューを再送しても新しい本人の利用日を延長しない", async () => {
  const first = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const second = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const visitor = crypto.randomUUID(),
    id = crypto.randomUUID();
  const send = (cookie: string) =>
    worker.fetch(
      new AcceptedGameRequest("http://localhost:5173/api/analytics/pageviews", {
        method: "POST",
        headers: {
          Cookie: `${cookie}; tetraboard-2026.analytics=${visitor}`,
          Origin: env.APP_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id, page: "account", game: null }),
      }),
      env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    );
  expect((await send(first.cookie)).status).toBe(204);
  expect((await send(second.cookie)).status).toBe(204);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM account_usage WHERE account_id=?")
      .bind(second.id)
      .first(),
  ).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT account_id FROM analytics_pageviews WHERE id=?")
      .bind(id)
      .first("account_id"),
  ).toBe(first.id);
});

test("保存期限まで終了結果がない局は長期集計で未確定と分かる", async () => {
  await resetFoundation();
  const match = crypto.randomUUID();
  await env.APP_DB.batch([
    env.APP_DB.prepare(
      "INSERT INTO analytics_matches VALUES(?,'reversi','singles',?,NULL,'playing',3)",
    ).bind(match, now),
    env.APP_DB.prepare(
      "INSERT INTO analytics_participants(match_id,player_id,visitor_id) VALUES(?,'guest',?)",
    ).bind(match, crypto.randomUUID()),
  ]);
  await aggregateAnalytics(env, now);
  expect((await readAnalyticsFoundation(env, query, now)).days[0]?.incomplete).toBe(false);
  const later = now + analyticsRetentionMs;
  await archiveAnalytics(env, later);
  await aggregateAnalytics(env, later + 1);
  expect((await readAnalyticsFoundation(env, query, later + 1)).days[0]).toMatchObject({
    started: 1,
    completed: 0,
    abandoned: 0,
    incomplete: true,
  });
});
