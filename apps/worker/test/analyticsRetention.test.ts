import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, afterEach, vi, test, expect } from "vitest";
import worker from "../src/worker";
import { accountFixture, origin } from "./accountFixtures";
import { AcceptedGameRequest } from "./acceptedGameRequest";
import { writeAnalyticsMatch } from "../src/analytics/store";
import { runAnalyticsAggregation } from "../src/analytics/foundation";
import type { GameId } from "@tetraboard/protocol";
const env = {
  ...bindings,
  APP_DB: (bindings as typeof bindings & { ANALYTICS_RETENTION_TEST_DB: D1Database })
    .ANALYTICS_RETENTION_TEST_DB,
};
beforeAll(async () => {
  await applyD1Migrations(
    env.APP_DB,
    (bindings as typeof bindings & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  );
});
const fixture = () => accountFixture(true, crypto.randomUUID(), env.APP_DB);
const now = Date.parse("2026-11-20T12:00:00+09:00"),
  start = Date.parse("2026-11-11T23:59:00+09:00");
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await env.APP_DB.batch([
    ...[
      "analytics_retention_subjects",
      "analytics_retention_daily",
      "analytics_retention_archive",
      "analytics_participants",
      "analytics_matches",
      "account_match_history",
      "shogi_rating_changes",
      "reversi_rating_changes",
      "four_shogi_rating_changes",
      "four_reversi_rating_changes",
      "matches",
      "user",
      "guest_account_merges",
      "deleted_accounts",
      "analytics_retention_accounts",
      "analytics_retention_dirty_days",
    ].map((t) => env.APP_DB.prepare(`DELETE FROM ${t}`)),
    env.APP_DB.prepare("DELETE FROM analytics_metadata WHERE key='retention_aggregated_at'"),
    env.APP_DB.prepare(
      "UPDATE analytics_metadata SET value=? WHERE key='retention_collected_from'",
    ).bind(start - 86400000),
  ]);
});
afterEach(() => vi.useRealTimers());
const context = { waitUntil() {} } as unknown as ExecutionContext;
async function completion(
  accountId: string,
  game: GameId,
  end: number,
  guest = false,
  known = true,
) {
  const id = crypto.randomUUID();
  await env.APP_DB.batch([
    env.APP_DB.prepare("INSERT INTO matches VALUES(?,?,?, ?,?,?)").bind(
      id,
      game,
      "standard",
      end - 60000,
      end,
      "{}",
    ),
    env.APP_DB.prepare(
      "INSERT INTO account_match_history(account_id,match_id,mode,started_at_ms,game) VALUES(?,?,?,?,?)",
    ).bind(accountId, id, "standard", end - 60000, game),
  ]);
  await writeAnalyticsMatch(env.APP_DB, {
    id,
    game,
    mode: "standard",
    startedAtMs: end - 60000,
    endedAtMs: end,
    status: "completed",
    cpuCount: 1,
    participants: [
      {
        playerId: crypto.randomUUID(),
        accountId,
        visitorId: null,
        isTest: false,
        isGuest: guest,
        completionIsGuest: known ? guest : undefined,
      },
    ],
  });
  return id;
}
async function beginning(accountId: string, game: GameId, at: number) {
  await writeAnalyticsMatch(env.APP_DB, {
    id: crypto.randomUUID(),
    game,
    mode: "standard",
    startedAtMs: at,
    endedAtMs: null,
    status: "playing",
    cpuCount: 1,
    participants: [{ playerId: crypto.randomUUID(), accountId, visitorId: null, isTest: false }],
  });
}
test("再対局の全体はアカウントを重複させず、開始・完了・起点の区分を維持して読み取る", async () => {
  const owner = await fixture(),
    player = await fixture();
  const bindings = { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]) };
  const get = () =>
    worker.fetch(
      new AcceptedGameRequest(
        origin + "/api/admin/analytics/retention?from=2026-11-11&to=2026-11-12",
        { headers: { Cookie: owner.cookie } },
      ),
      bindings,
      context,
    );
  expect((await get()).status).toBe(200);
  await env.APP_DB.prepare(
    "UPDATE analytics_metadata SET value=? WHERE key='retention_collected_from'",
  )
    .bind(start - 86400000)
    .run();
  await completion(player.id, "gomoku", start, true);
  await completion(player.id, "shogi", start + 120000, false);
  await beginning(player.id, "gomoku", start + 168 * 3600000 + 1);
  await runAnalyticsAggregation(bindings, now);
  const report = (await (await get()).json()) as {
    returns: {
      game: string;
      kind: string;
      eligible: number;
      retained: number;
      retainedNextDay: number;
      observing: number;
    }[];
  };
  expect(report.returns.find((r) => r.game === "all" && r.kind === "guest")).toMatchObject({
    eligible: 1,
    retained: 1,
    retainedNextDay: 1,
    observing: 0,
  });
  expect(report.returns.find((r) => r.game === "gomoku" && r.kind === "guest")).toMatchObject({
    eligible: 1,
    retained: 0,
    retainedNextDay: 0,
  });
  expect(report.returns.filter((r) => r.game === "all").reduce((n, r) => n + r.eligible, 0)).toBe(
    1,
  );
});

test("168時間の直前・一致・直後、日本時間の別日、観測中と不明を分母・分子から区別する", async () => {
  const { aggregateRetention, readRetention } = await import("../src/analytics/retentionCohorts");
  for (const delta of [-1, 0, 1]) {
    const p = await fixture();
    await completion(p.id, "gomoku", start);
    await beginning(p.id, "gomoku", start + 168 * 3600000 + delta);
  }
  const sameDay = await fixture();
  await completion(sameDay.id, "gomoku", start - 600000);
  await beginning(sameDay.id, "gomoku", start - 300000);
  const observing = await fixture();
  await completion(observing.id, "gomoku", now - 3600000);
  await beginning(observing.id, "gomoku", now - 1000);
  const unknown = await fixture();
  await completion(unknown.id, "gomoku", start, false, false);
  await aggregateRetention({ ...env, ADMIN_ACCOUNT_IDS: "[]" }, now);
  const report = await readRetention(
    env,
    { from: "2026-11-11", to: "2026-11-20", game: "all", bucket: "day", includeInternal: "false" },
    now,
  );
  expect(report.returns.find((r) => r.game === "all" && r.kind === "registered")).toMatchObject({
    enrolled: 5,
    eligible: 4,
    retained: 3,
    retainedNextDay: 2,
    observing: 1,
    rate: 0.75,
  });
  expect(report.returns.find((r) => r.game === "all" && r.kind === "unknown")).toMatchObject({
    unknown: 1,
    eligible: 0,
    rate: null,
  });
});

test.each(["shogi", "reversi", "four-shogi", "four-reversi"] as const)(
  "%sの認定は有効局の1〜5到達だけを数え、5局目後の再利用を独立した7日で測る",
  async (game) => {
    const { aggregateRetention, readRetention } = await import("../src/analytics/retentionCohorts");
    const table = game.replaceAll("-", "_") + "_rating_changes",
      four = game.startsWith("four-");
    async function rating(account: string, n: number, end: number) {
      const id = await completion(account, game, end);
      await env.APP_DB.prepare(
        four
          ? `INSERT INTO ${table} VALUES(?,?,25,8,26,7,?,1)`
          : `INSERT INTO ${table} VALUES(?,?,1500,1550,?,1)`,
      )
        .bind(id, account, n)
        .run();
    }
    const player = await fixture();
    for (let n = 1; n <= 5; n++) await rating(player.id, n, start + (n - 1) * 3600000);
    await beginning(player.id, game, start + 4 * 3600000 + 168 * 3600000);
    const pending = await fixture();
    await rating(pending.id, 1, start);
    await rating(pending.id, 2, start + 3600000);
    for (let n = 3; n <= 6; n++) await completion(pending.id, game, start + n * 3600000);
    const legacy = await fixture();
    await rating(legacy.id, 1, start - 120 * 86400000);
    await rating(legacy.id, 5, start + 7200000);
    await aggregateRetention({ ...env, ADMIN_ACCOUNT_IDS: "[]" }, now);
    const report = await readRetention(
      env,
      { from: "2026-11-11", to: "2026-11-20", game, bucket: "day", includeInternal: "false" },
      now,
    );
    expect(report.placement.find((r) => r.kind === "registered")).toMatchObject({
      enrolled: 2,
      observing: 2,
      reached: [2, 2, 1, 1, 1],
      rate: null,
    });
    expect(report.postPlacement.find((r) => r.kind === "registered")).toMatchObject({
      eligible: 2,
      retained: 1,
      rate: 0.5,
      observing: 0,
    });
  },
);

test("90日削除後は匿名値だけを保持し、保存履歴の初回をもう一度作らない", async () => {
  const { aggregateRetention, readRetention } = await import("../src/analytics/retentionCohorts");
  const { archiveAnalytics } = await import("../src/analytics/retention");
  const { analyticsRetentionMs } = await import("@tetraboard/protocol/privacy");
  const player = await fixture();
  await completion(player.id, "gomoku", start, true);
  await beginning(player.id, "gomoku", start + 3600000);
  const bindings = { ...env, ADMIN_ACCOUNT_IDS: "[]" };
  await aggregateRetention(bindings, now);
  const later = start + analyticsRetentionMs + 1000;
  vi.setSystemTime(later);
  await archiveAnalytics(bindings, later);
  await aggregateRetention(bindings, later);
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) FROM analytics_retention_subjects").first("COUNT(*)"),
  ).toBe(0);
  await completion(player.id, "gomoku", later);
  await aggregateRetention(bindings, later);
  const q = {
    from: "2026-11-11",
    to: "2026-11-20",
    game: "all",
    bucket: "day",
    includeInternal: "false",
  } as const;
  expect((await readRetention(env, q, later)).returns.find((r) => r.game === "all")).toMatchObject({
    eligible: 1,
    retained: 1,
    enrolled: 1,
  });
  await archiveAnalytics(bindings, later);
  await aggregateRetention(bindings, later);
  expect((await readRetention(env, q, later)).returns.find((r) => r.game === "all")!.enrolled).toBe(
    1,
  );
  const columns = (
    await env.APP_DB.prepare("PRAGMA table_info(analytics_retention_archive)").all<{
      name: string;
    }>()
  ).results.map((r) => r.name);
  expect(columns).not.toContain("account_id");
  expect(columns).not.toContain("origin_match_id");
});

test("保存・公開途中のD1障害は前回値と時刻を保持し、再実行と観測満了で整合する", async () => {
  const { aggregateRetention, readRetention } = await import("../src/analytics/retentionCohorts");
  const bindings = { ...env, ADMIN_ACCOUNT_IDS: "[]" };
  const a = await fixture();
  await completion(a.id, "gomoku", start);
  await aggregateRetention(bindings, now);
  const q = {
    from: "2026-11-11",
    to: "2026-11-20",
    game: "all",
    bucket: "day",
    includeInternal: "false",
  } as const;
  const before = await readRetention(env, q, now);
  const b = await fixture();
  await completion(b.id, "gomoku", now - 3600000);
  await beginning(b.id, "gomoku", now - 1000);
  await env.APP_DB.exec(
    "CREATE TRIGGER retention_test_fail BEFORE INSERT ON analytics_retention_daily BEGIN SELECT RAISE(ABORT,'test publish failure'); END;",
  );
  try {
    await expect(aggregateRetention(bindings, now + 1)).rejects.toThrow();
    const failed = await readRetention(env, q, now + 1);
    expect(failed.aggregatedAtMs).toBe(before.aggregatedAtMs);
    expect(failed.returns.find((r) => r.game === "all")!.enrolled).toBe(1);
  } finally {
    await env.APP_DB.exec("DROP TRIGGER retention_test_fail");
  }
  await aggregateRetention(bindings, now + 2);
  const observed = await readRetention(env, q, now + 2);
  expect(observed.returns.find((r) => r.game === "all")).toMatchObject({
    eligible: 1,
    retained: 0,
    observing: 1,
  });
  const maturity = now - 3600000 + 168 * 3600000;
  vi.setSystemTime(maturity);
  await aggregateRetention(bindings, maturity);
  expect(
    (await readRetention(env, q, maturity)).returns.find((r) => r.game === "all"),
  ).toMatchObject({ eligible: 2, retained: 1, observing: 0 });
  const sql: string[] = [];
  const db = new Proxy(env.APP_DB, {
    get(t, k) {
      if (k === "prepare")
        return (s: string) => {
          sql.push(s);
          return t.prepare(s);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  await readRetention({ ...env, APP_DB: db }, q, maturity);
  expect(
    sql.some((s) =>
      /analytics_retention_subjects|analytics_participants|account_match_history|sqlite_master|pragma_table_info|INSERT INTO|DELETE FROM|UPDATE /i.test(
        s,
      ),
    ),
  ).toBe(false);
});

test("ゲスト統合は起点・区分・分析の本人を遡ってまとめず、退会と遅延保存で復活させない", async () => {
  const { aggregateRetention, readRetention } = await import("../src/analytics/retentionCohorts");
  const bindings = { ...env, ADMIN_ACCOUNT_IDS: "[]" };
  const guest = await fixture(),
    registered = await fixture();
  await env.APP_DB.prepare("UPDATE user SET isAnonymous=1 WHERE id=?").bind(guest.id).run();
  await completion(guest.id, "gomoku", start, true);
  await completion(registered.id, "gomoku", start + 3600000);
  await aggregateRetention(bindings, now);
  const hash = crypto.randomUUID(),
    oauthState = crypto.randomUUID();
  await env.APP_DB.batch([
    env.APP_DB.prepare(
      "INSERT INTO guest_sessions(token_hash,account_id,expires_at_ms) VALUES(?,?,?)",
    ).bind(hash, guest.id, now + 10000),
    env.APP_DB.prepare(
      "INSERT INTO guest_oauth_flows(state,guest_id,guest_token_hash,provider,started_at_ms,expires_at_ms,target_id,target_session_id) VALUES(?,?,?,'google',?,?,?,(SELECT id FROM session WHERE token=?))",
    ).bind(oauthState, guest.id, hash, now - 10, now + 10000, registered.id, registered.token),
    env.APP_DB.prepare("INSERT INTO guest_account_merges VALUES(?,?,?)").bind(
      guest.id,
      registered.id,
      now,
    ),
    env.APP_DB.prepare("UPDATE account_match_history SET account_id=? WHERE account_id=?").bind(
      registered.id,
      guest.id,
    ),
    env.APP_DB.prepare("UPDATE analytics_participants SET account_id=? WHERE account_id=?").bind(
      registered.id,
      guest.id,
    ),
  ]);
  await beginning(registered.id, "gomoku", start + 7200000);
  await aggregateRetention(bindings, now);
  const q = {
    from: "2026-11-11",
    to: "2026-11-20",
    game: "all",
    bucket: "day",
    includeInternal: "false",
  } as const;
  const merged = await readRetention(env, q, now);
  expect(merged.returns.find((r) => r.game === "all" && r.kind === "guest")).toMatchObject({
    eligible: 1,
    retained: 0,
  });
  expect(merged.returns.find((r) => r.game === "all" && r.kind === "registered")).toMatchObject({
    eligible: 1,
    retained: 1,
  });
  await env.APP_DB.prepare(
    "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES(?,?,?)",
  )
    .bind(registered.id, now, crypto.randomUUID())
    .run();
  await completion(registered.id, "gomoku", now);
  await aggregateRetention(bindings, now);
  const after = await readRetention(env, q, now);
  expect(after.returns.some((r) => r.game === "all" && r.kind === "registered")).toBe(false);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_retention_subjects WHERE account_id=?")
      .bind(registered.id)
      .first(),
  ).toBeNull();
});

test("認定の90日最終値を匿名化し、起点以前の期間・未認証・権限不足を区別する", async () => {
  const { aggregateRetention, readRetention } = await import("../src/analytics/retentionCohorts");
  const { archiveAnalytics } = await import("../src/analytics/retention");
  const { analyticsRetentionMs } = await import("@tetraboard/protocol/privacy");
  const player = await fixture(),
    owner = await fixture(),
    other = await fixture(),
    bindings = { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify([owner.id]) };
  const first = await completion(player.id, "shogi", start);
  await env.APP_DB.prepare("INSERT INTO shogi_rating_changes VALUES(?,?,1500,1501,1,1)")
    .bind(first, player.id)
    .run();
  await aggregateRetention(bindings, now);
  const edge = start + analyticsRetentionMs;
  vi.setSystemTime(edge);
  const fifth = await completion(player.id, "shogi", edge);
  await env.APP_DB.prepare("INSERT INTO shogi_rating_changes VALUES(?,?,1501,1502,5,1)")
    .bind(fifth, player.id)
    .run();
  await aggregateRetention(bindings, edge);
  const pending = await readRetention(
    env,
    {
      from: "2026-11-11",
      to: "2026-11-20",
      game: "shogi",
      bucket: "day",
      includeInternal: "false",
    },
    edge,
  );
  expect(pending.status).toBe("delayed");
  expect(pending.placement[0]!.observing).toBe(1);
  await archiveAnalytics(bindings, edge);
  await aggregateRetention(bindings, edge);
  const q = {
    from: "2026-11-11",
    to: "2026-11-20",
    game: "shogi",
    bucket: "day",
    includeInternal: "false",
  } as const;
  expect((await readRetention(env, q, edge)).placement[0]).toMatchObject({
    enrolled: 1,
    eligible: 1,
    observing: 0,
    reached: [1, 0, 0, 0, 1],
  });
  expect(
    (await readRetention(env, { ...q, from: "2020-01-01", to: "2020-01-02" }, edge)).coverage,
  ).toBe("unmeasured");
  vi.setSystemTime(now);
  const path = "/api/admin/analytics/retention?from=2026-11-11&to=2026-11-20";
  const get = (cookie?: string) =>
    worker.fetch(
      new AcceptedGameRequest(origin + path, { headers: cookie ? { Cookie: cookie } : {} }),
      bindings,
      context,
    );
  expect((await get()).status).toBe(401);
  expect((await get(other.cookie)).status).toBe(403);
  const ok = await get(owner.cookie);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("Cache-Control")).toBe("no-store");
});

test("終局より先に開始記録が90日削除されても確定済みの認定区分を保ち、起点不明を到達人数に補わない", async () => {
  const { aggregateRetention, readRetention } = await import("../src/analytics/retentionCohorts");
  const { archiveAnalytics } = await import("../src/analytics/retention");
  const { analyticsRetentionMs } = await import("@tetraboard/protocol/privacy");
  const player = await fixture(),
    unknown = await fixture();
  const first = await completion(player.id, "shogi", start);
  const missing = await completion(unknown.id, "shogi", start);
  await env.APP_DB.batch([
    env.APP_DB.prepare("INSERT INTO shogi_rating_changes VALUES(?,?,1500,1501,1,1)").bind(
      first,
      player.id,
    ),
    env.APP_DB.prepare("INSERT INTO shogi_rating_changes VALUES(?,?,1500,1501,1,1)").bind(
      missing,
      unknown.id,
    ),
    env.APP_DB.prepare("DELETE FROM analytics_participants WHERE match_id=?").bind(missing),
  ]);
  const bindings = { ...env, ADMIN_ACCOUNT_IDS: "[]" };
  const q = {
    from: "2026-11-11",
    to: "2026-11-20",
    game: "shogi",
    bucket: "day",
    includeInternal: "false",
  } as const;
  await aggregateRetention(bindings, now);
  const beforeExpiry = start + analyticsRetentionMs - 30000;
  await archiveAnalytics(bindings, beforeExpiry);
  await aggregateRetention(bindings, beforeExpiry);
  expect(
    (await readRetention(env, q, beforeExpiry)).placement.find((r) => r.kind === "registered"),
  ).toMatchObject({ observing: 1, unknown: 0, reached: [1, 0, 0, 0, 0] });
  const expired = start + analyticsRetentionMs;
  await archiveAnalytics(bindings, expired);
  await aggregateRetention(bindings, expired);
  const archived = await readRetention(env, q, expired);
  expect(archived.placement.find((r) => r.kind === "registered")).toMatchObject({
    eligible: 1,
    unknown: 0,
    reached: [1, 0, 0, 0, 0],
  });
  expect(archived.placement.find((r) => r.kind === "unknown")).toMatchObject({
    eligible: 0,
    unknown: 1,
    reached: [0, 0, 0, 0, 0],
  });
});

test("本人・テストの除外は32人設定でも保ち、起点区分は後日の変更で動かない", async () => {
  const { aggregateRetention, readRetention } = await import("../src/analytics/retentionCohorts");
  const player = await fixture(),
    owner = await fixture(),
    tester = await fixture();
  await completion(player.id, "gomoku", start, true);
  await completion(owner.id, "gomoku", start);
  const testMatch = await completion(tester.id, "gomoku", start);
  await env.APP_DB.prepare("UPDATE analytics_participants SET is_test=1 WHERE match_id=?")
    .bind(testMatch)
    .run();
  const bindings = {
    ...env,
    ADMIN_ACCOUNT_IDS: JSON.stringify([
      owner.id,
      ...Array.from({ length: 31 }, () => crypto.randomUUID()),
    ]),
  };
  await aggregateRetention(bindings, now);
  await env.APP_DB.prepare("UPDATE analytics_participants SET is_test=0 WHERE match_id=?")
    .bind(testMatch)
    .run();
  await env.APP_DB.prepare("UPDATE user SET isAnonymous=0 WHERE id=?").bind(player.id).run();
  await aggregateRetention(bindings, now);
  const q = {
    from: "2026-11-11",
    to: "2026-11-20",
    game: "all",
    bucket: "day",
    includeInternal: "false",
  } as const;
  const ordinary = await readRetention(env, q, now),
    all = await readRetention(env, { ...q, includeInternal: "true" }, now);
  expect(ordinary.returns.filter((r) => r.game === "all").reduce((n, r) => n + r.enrolled, 0)).toBe(
    1,
  );
  expect(ordinary.returns.find((r) => r.game === "all")!.kind).toBe("guest");
  expect(all.returns.filter((r) => r.game === "all").reduce((n, r) => n + r.enrolled, 0)).toBe(3);
});

test("遅れて保存された初回完了へ起点を訂正し、同じ完了の再送では人数を増やさない", async () => {
  const { aggregateRetention, readRetention } = await import("../src/analytics/retentionCohorts");
  const player = await fixture(),
    bindings = { ...env, ADMIN_ACCOUNT_IDS: "[]" };
  await completion(player.id, "gomoku", start + 3600000);
  await aggregateRetention(bindings, now);
  const q = {
    from: "2026-11-11",
    to: "2026-11-12",
    game: "all",
    bucket: "day",
    includeInternal: "false",
  } as const;
  expect((await readRetention(env, q, now)).returns.find((r) => r.game === "all")!.kind).toBe(
    "registered",
  );
  const id = await completion(player.id, "gomoku", start, true);
  await aggregateRetention(bindings, now);
  await writeAnalyticsMatch(env.APP_DB, {
    id,
    game: "gomoku",
    mode: "standard",
    startedAtMs: start - 60000,
    endedAtMs: start,
    status: "completed",
    cpuCount: 1,
    participants: [],
  });
  await aggregateRetention(bindings, now);
  const after = await readRetention(env, q, now);
  expect(after.returns.find((r) => r.game === "all")).toMatchObject({
    kind: "guest",
    enrolled: 1,
    eligible: 1,
    retained: 1,
  });
  expect(after.returns.filter((r) => r.game === "all")).toHaveLength(1);
});
