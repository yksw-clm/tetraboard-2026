import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { accountFixture } from "./accountFixtures";
import {
  enqueueMatchmakingEvent,
  flushMatchmakingEvents,
} from "../src/analytics/matchmakingEvents";

const env = {
  ...bindings,
  APP_DB: (bindings as typeof bindings & { MATCH_LIFECYCLE_TEST_DB: D1Database })
    .MATCH_LIFECYCLE_TEST_DB,
};
beforeAll(async () =>
  applyD1Migrations(
    env.APP_DB,
    (bindings as typeof bindings & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] })
      .TEST_MIGRATIONS,
  ),
);

test("検索イベントの保存失敗は伝播せず、再開後の再送も同じ段階を二重計上しない", async () => {
  const user = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const namespace = env.MATCHMAKING_COORDINATOR.getByName(`analytics-test-${crypto.randomUUID()}`);
  const now = Date.now(),
    operationId = crypto.randomUUID();
  await runInDurableObject(namespace, async (_instance, state) => {
    const event = {
      operationId,
      accountId: user.id,
      matchId: null,
      game: "shogi" as const,
      stage: "accepted" as const,
      reason: null,
      atMs: now,
      waitingMs: null,
      humans: null,
      rated: true,
    };
    state.storage.transactionSync(() => enqueueMatchmakingEvent(state.storage, event));
    const unavailable = {
      prepare() {
        throw new Error("unavailable");
      },
    } as unknown as D1Database;
    expect(await flushMatchmakingEvents(state.storage, unavailable, now)).toBe(now + 5000);
  });
  await runInDurableObject(namespace, async (_instance, state) => {
    expect(await flushMatchmakingEvents(state.storage, env.APP_DB, now + 5000)).toBeNull();
    enqueueMatchmakingEvent(state.storage, {
      operationId,
      accountId: user.id,
      matchId: null,
      game: "shogi",
      stage: "accepted",
      reason: null,
      atMs: now,
      waitingMs: null,
      humans: null,
      rated: true,
    });
    expect(await flushMatchmakingEvents(state.storage, env.APP_DB, now + 5001)).toBeNull();
  });
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) AS count FROM analytics_matchmaking_events WHERE operation_id=?",
    )
      .bind(operationId)
      .first("count"),
  ).toBe(1);
});

import { writeAnalyticsMatch, type AnalyticsMatch } from "../src/analytics/store";
import { aggregateLifecycleAnalytics } from "../src/analytics/lifecycleAggregation";
import { archiveAnalytics } from "../src/analytics/retention";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";

async function match(atMs: number, game = "shogi", kind: AnalyticsMatch["matchKind"] = "rated") {
  const user = await accountFixture(true, crypto.randomUUID(), env.APP_DB);
  const record: AnalyticsMatch = {
    id: crypto.randomUUID(),
    game,
    mode: "standard",
    startedAtMs: atMs,
    endedAtMs: atMs + 1000,
    status: "completed",
    cpuCount: 1,
    humanCount: 1,
    matchKind: kind,
    endReason: "last_player",
    participants: [
      {
        playerId: crypto.randomUUID(),
        accountId: user.id,
        visitorId: null,
        isTest: false,
        endReason: "resigned",
        search: { operationId: crypto.randomUUID(), joinedAtMs: atMs - 20000 },
      },
    ],
  };
  await writeAnalyticsMatch(env.APP_DB, record);
  return record;
}
const dayOf = (at: number) => new Date(at + 9 * 3600000).toISOString().slice(0, 10);
async function rows(at: number, internal = 1) {
  return (
    await env.APP_DB.prepare(
      "SELECT scope,reason,count,waiting_ms,waiting_samples FROM analytics_lifecycle_daily WHERE day=? AND internal=? ORDER BY scope,reason",
    )
      .bind(dayOf(at), internal)
      .all()
  ).results;
}
test("開始・完了・席の終了理由とレート保存待ちを分離し、再送と5分集計の再実行でも増やさない", async () => {
  const at = Date.now() - 2 * 86400000,
    record = await match(at);
  await writeAnalyticsMatch(env.APP_DB, record);
  await aggregateLifecycleAnalytics(env);
  expect(await rows(at)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scope: "search_started", count: 1 }),
      expect.objectContaining({ scope: "match_completed", reason: "last_player", count: 1 }),
      expect.objectContaining({ scope: "participant_end", reason: "resigned", count: 1 }),
      expect.objectContaining({ scope: "rating", reason: "pending", count: 1 }),
    ]),
  );
  const before = await rows(at);
  await aggregateLifecycleAnalytics(env);
  expect(await rows(at)).toEqual(before);
  // 棋譜保存後もレート保存待ちの間は、対象外に確定しません。
  await env.APP_DB.batch([
    env.APP_DB.prepare("INSERT INTO shogi_rating_pending(account_id,match_id) VALUES (?,?)").bind(
      record.participants[0]!.accountId,
      record.id,
    ),
    env.APP_DB.prepare(
      "INSERT INTO matches(id,game,mode,started_at_ms,ended_at_ms,record_json) VALUES (?,'shogi','standard',?,?,?)",
    ).bind(
      record.id,
      at,
      at + 1000,
      JSON.stringify({ rating: { kind: "cpu", usedFallback: true } }),
    ),
  ]);
  await aggregateLifecycleAnalytics(env);
  expect(await rows(at)).toContainEqual(
    expect.objectContaining({ scope: "rating", reason: "pending" }),
  );
  await env.APP_DB.prepare("DELETE FROM shogi_rating_pending WHERE match_id=?")
    .bind(record.id)
    .run();
  await aggregateLifecycleAnalytics(env);
  expect(await rows(at)).toContainEqual(
    expect.objectContaining({ scope: "rating", reason: "ai_fallback", count: 1 }),
  );
  expect(await rows(at)).not.toContainEqual(
    expect.objectContaining({ scope: "rating", reason: "pending" }),
  );
});

test("レート保存待ちが先に消えた後の差分到着も、その開始日だけを再集計する", async () => {
  const at = Date.now() - 5 * 86400000,
    record = await match(at);
  await env.APP_DB.prepare(
    "INSERT INTO matches(id,game,mode,started_at_ms,ended_at_ms,record_json) VALUES (?,'shogi','standard',?,?,?)",
  )
    .bind(record.id, at, at + 1000, JSON.stringify({ rating: { kind: "human" } }))
    .run();
  await aggregateLifecycleAnalytics(env);
  expect(await rows(at)).toContainEqual(
    expect.objectContaining({ scope: "rating", reason: "unavailable" }),
  );
  await env.APP_DB.prepare(
    "INSERT INTO shogi_rating_changes(match_id,account_id,rating_before,rating_after,rated_games,human_games) VALUES (?,?,1500,1516,1,1)",
  )
    .bind(record.id, record.participants[0]!.accountId)
    .run();
  await aggregateLifecycleAnalytics(env);
  expect(await rows(at)).toContainEqual(
    expect.objectContaining({ scope: "rating", reason: "included", count: 1 }),
  );
  expect(
    await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM analytics_lifecycle_dirty_days").first("n"),
  ).toBe(0);
});

test("集計の途中失敗で公開値と時刻を進めず、次の実行で内部除外と遅れた完了を反映する", async () => {
  const at = Date.now() - 3 * 86400000,
    record = await match(at, "reversi", "normal");
  const owners = Array.from({ length: 32 }, () => crypto.randomUUID());
  owners[0] = record.participants[0]!.accountId!;
  const scoped = { ...env, ADMIN_ACCOUNT_IDS: JSON.stringify(owners) };
  await aggregateLifecycleAnalytics(scoped, at + 10000);
  expect(await rows(at, 0)).toEqual([]);
  expect(await rows(at, 1)).not.toEqual([]);
  const old = await env.APP_DB.prepare(
    "SELECT value FROM analytics_metadata WHERE key='lifecycle_aggregated_at'",
  ).first("value");
  await env.APP_DB.prepare("UPDATE analytics_matches SET end_reason='all_passed' WHERE id=?")
    .bind(record.id)
    .run();
  // 実DB batch内の後半で失敗させ、先行DELETEもロールバックすることを確認します。
  const failing = new Proxy(env.APP_DB, {
    get(target, key) {
      if (key === "batch")
        return (stmts: D1PreparedStatement[]) =>
          target.batch([...stmts, target.prepare("SELECT * FROM missing_lifecycle_test_table")]);
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await expect(
    aggregateLifecycleAnalytics({ ...scoped, APP_DB: failing }, Date.now() + 1000),
  ).rejects.toThrow();
  expect(await rows(at, 1)).toContainEqual(
    expect.objectContaining({ scope: "match_completed", reason: "last_player" }),
  );
  expect(
    await env.APP_DB.prepare(
      "SELECT value FROM analytics_metadata WHERE key='lifecycle_aggregated_at'",
    ).first("value"),
  ).toBe(old);
  await aggregateLifecycleAnalytics(scoped);
  expect(await rows(at, 1)).toContainEqual(
    expect.objectContaining({ scope: "match_completed", reason: "all_passed" }),
  );
});

test("退会後の遅延再送は検索の対応表を復元せず、90日期限では匿名集計だけを一度残す", async () => {
  const at = Date.now() - 4 * 86400000,
    record = await match(at, "gomoku", "normal");
  const accountId = record.participants[0]!.accountId!;
  await env.APP_DB.prepare(
    "INSERT INTO deleted_accounts(id,requested_at_ms,receipt_hash) VALUES (?,?,?)",
  )
    .bind(accountId, Date.now(), crypto.randomUUID())
    .run();
  await writeAnalyticsMatch(env.APP_DB, record);
  expect(
    await env.APP_DB.prepare(
      "SELECT COUNT(*) AS n FROM analytics_matchmaking_events WHERE account_id=?",
    )
      .bind(accountId)
      .first("n"),
  ).toBe(0);
  const future = Date.now() + analyticsRetentionMs + 1;
  await archiveAnalytics(env, future);
  await aggregateLifecycleAnalytics(env, future);
  const archived = await rows(at);
  expect(archived).toContainEqual(expect.objectContaining({ scope: "match_completed", count: 1 }));
  await archiveAnalytics(env, future);
  await aggregateLifecycleAnalytics(env, future);
  expect(await rows(at)).toEqual(archived);
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_matches WHERE id=?").bind(record.id).first(),
  ).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_participants WHERE match_id=?")
      .bind(record.id)
      .first(),
  ).toBeNull();
  expect(
    await env.APP_DB.prepare("SELECT 1 FROM analytics_matchmaking_events WHERE match_id=?")
      .bind(record.id)
      .first(),
  ).toBeNull();
  const columns = (
    await env.APP_DB.prepare("PRAGMA table_info(analytics_lifecycle_archive)").all<{
      name: string;
    }>()
  ).results.map((r) => r.name);
  expect(columns.some((c) => /account|visitor|operation|match_id|player_id/.test(c))).toBe(false);
});
