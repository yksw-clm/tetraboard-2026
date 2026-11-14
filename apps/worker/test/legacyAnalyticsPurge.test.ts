import { env as bindings } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import { purgeLegacyAnalytics } from "../src/legacyAnalyticsPurge";
import { accountFixture } from "./accountFixtures";

const db = (bindings as typeof bindings & { ANALYTICS_FOUNDATION_TEST_DB: D1Database })
  .ANALYTICS_FOUNDATION_TEST_DB;
beforeAll(async () =>
  applyD1Migrations(
    db,
    (
      bindings as typeof bindings & {
        TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
      }
    ).TEST_MIGRATIONS,
  ),
);

const dayOf = (at: number) => new Date(at + 32400000).toISOString().slice(0, 10);
const exists = (table: string, column: string, value: string) =>
  db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`).bind(value).first();

test("90日と有効期限の境界までを削除し、期限内の行と匿名集計は保持する", async () => {
  const now = Date.parse("2026-11-15T12:00:00+09:00");
  const cutoff = now - analyticsRetentionMs;
  const account = await accountFixture(false, crypto.randomUUID(), db);
  const tables = [
    "analytics_daily",
    "analytics_daily_v2",
    "analytics_foundation_archive",
    "analytics_lifecycle_archive",
    "analytics_registration_archive",
    "analytics_acquisition_daily",
  ];
  const counts = () =>
    Promise.all(
      tables.map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n")),
    );
  const before = await counts();
  for (const delta of [-1, 0, 1]) {
    const id = String(delta);
    const at = cutoff + delta;
    const day = dayOf(cutoff + delta * 86400000);
    await db.batch([
      db
        .prepare(
          "INSERT INTO analytics_matchmaking_events(id,operation_id,account_id,game,stage,at_ms,rated) VALUES(?,?,?,'shogi','accepted',?,0)",
        )
        .bind(id, id, account.id, at),
      db
        .prepare(
          "INSERT INTO analytics_registration_flows(id,created_at_ms,kind,entry,game) VALUES(?,?,'unregistered','login-page','all')",
        )
        .bind(id, at),
      db.prepare("INSERT INTO analytics_registration_events VALUES(?,'entry',?)").bind(id, at),
      db
        .prepare("INSERT INTO analytics_registration_deleted_flows VALUES(?,?)")
        .bind(id, now + delta),
      db
        .prepare(
          "INSERT INTO analytics_sessions(id,visitor_id,started_at_ms,last_activity_ms) VALUES(?,?,?,?)",
        )
        .bind(id, id, at, now),
      db.prepare("INSERT INTO analytics_session_visits VALUES(?,'*',?,NULL,0)").bind(id, at),
      db
        .prepare(
          "INSERT INTO analytics_pageviews(id,visitor_id,page,started_at_ms) VALUES(?,?,'general-lobby',?)",
        )
        .bind(id, id, at),
      db.prepare("INSERT INTO analytics_dwell VALUES(?,?,1)").bind(id, day),
      db
        .prepare(
          "INSERT INTO analytics_matches(id,game,mode,started_at_ms,status,cpu_count) VALUES(?,'shogi','standard',?,'playing',0)",
        )
        .bind(id, at),
      db.prepare("INSERT INTO analytics_participants(match_id,player_id) VALUES(?,?)").bind(id, id),
      db.prepare("INSERT INTO account_game_daily VALUES(?,?,'shogi',1)").bind(account.id, day),
      db
        .prepare(
          "INSERT INTO analytics_acquisition_snapshot VALUES(?,'all',0,'host','example.com','','',1,0)",
        )
        .bind(day),
      db
        .prepare(
          "INSERT INTO analytics_acquisition_snapshot VALUES(?,'all',0,'referrer','social','','',1,0)",
        )
        .bind(day),
    ]);
  }
  // 手続きの保持期限とOAuth試行の有効期限は別に検証します。
  for (const delta of [-1, 0, 1])
    await db
      .prepare("INSERT INTO analytics_registration_attempts VALUES(?,?,'google',?,?)")
      .bind(String(delta), "1", now, now + delta)
      .run();
  await purgeLegacyAnalytics({ APP_DB: db }, now);
  await purgeLegacyAnalytics({ APP_DB: db }, now);
  for (const delta of [-1, 0, 1]) {
    const id = String(delta);
    for (const [table, column] of [
      ["analytics_matchmaking_events", "id"],
      ["analytics_registration_flows", "id"],
      ["analytics_registration_events", "flow_id"],
      ["analytics_registration_attempts", "state_hash"],
      ["analytics_registration_deleted_flows", "id"],
      ["analytics_sessions", "id"],
      ["analytics_session_visits", "session_id"],
      ["analytics_pageviews", "id"],
      ["analytics_dwell", "view_id"],
      ["analytics_matches", "id"],
      ["analytics_participants", "match_id"],
    ])
      expect(Boolean(await exists(table!, column!, id)), `${table}:${delta}`).toBe(delta > 0);
    const day = dayOf(cutoff + delta * 86400000);
    expect(Boolean(await exists("account_game_daily", "day", day))).toBe(delta > 0);
    const dimensions = await db
      .prepare(
        "SELECT dimension FROM analytics_acquisition_snapshot WHERE day=? ORDER BY dimension",
      )
      .bind(day)
      .all<{ dimension: string }>();
    expect(dimensions.results.map((row) => row.dimension)).toEqual(
      delta > 0 ? ["host", "referrer"] : ["referrer"],
    );
  }
  expect(await counts()).toEqual(before);
});

test("削除の途中失敗はbatch全体を戻し、次の実行で削除できる", async () => {
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO analytics_matchmaking_events(id,operation_id,account_id,game,stage,at_ms,rated) VALUES(?,?,?,'shogi','accepted',0,0)",
    )
    .bind(id, id, id)
    .run();
  const broken = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return (statements: D1PreparedStatement[]) =>
          target.batch([
            statements[0]!,
            target.prepare("DELETE FROM missing_purge_table"),
            ...statements.slice(1),
          ]);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(purgeLegacyAnalytics({ APP_DB: broken })).rejects.toThrow();
  expect(await exists("analytics_matchmaking_events", "id", id)).not.toBeNull();
  await purgeLegacyAnalytics({ APP_DB: db });
  expect(await exists("analytics_matchmaking_events", "id", id)).toBeNull();
});

test("分析テーブルが残る間も退会は本人の行だけを消し、他者の行を残す", async () => {
  const { requestDeletion, processDeletions } = await import("../src/privacy/deletion");
  const users = await Promise.all([
    accountFixture(false, crypto.randomUUID(), db),
    accountFixture(false, crypto.randomUUID(), db),
  ]);
  for (const user of users) {
    await db.batch([
      db
        .prepare(
          "INSERT INTO analytics_sessions(id,visitor_id,account_id,started_at_ms,last_activity_ms) VALUES(?,?,?,?,?)",
        )
        .bind(user.id, user.id, user.id, Date.now(), Date.now()),
      db
        .prepare(
          "INSERT INTO analytics_pageviews(id,visitor_id,account_id,page,started_at_ms,session_id) VALUES(?,?,?,'general-lobby',?,?)",
        )
        .bind(user.id, user.id, user.id, Date.now(), user.id),
      db.prepare("INSERT INTO analytics_dwell VALUES(?,?,1)").bind(user.id, dayOf(Date.now())),
      db
        .prepare(
          "INSERT INTO analytics_matches(id,game,mode,started_at_ms,status,cpu_count) VALUES(?,'shogi','standard',?,'playing',0)",
        )
        .bind(user.id, Date.now()),
      db
        .prepare(
          "INSERT INTO analytics_participants(match_id,player_id,account_id,visitor_id,session_id) VALUES(?,?,?,?,?)",
        )
        .bind(user.id, user.id, user.id, user.id, user.id),
    ]);
  }
  const configured = { ...bindings, APP_DB: db };
  expect(await requestDeletion(configured, users[0]!.id, crypto.randomUUID())).toBe(true);
  await processDeletions(configured);
  expect(await exists("user", "id", users[0]!.id)).toBeNull();
  for (const [index, user] of users.entries()) {
    for (const [table, column] of [
      ["analytics_sessions", "id"],
      ["analytics_pageviews", "id"],
      ["analytics_dwell", "view_id"],
      ["analytics_participants", "account_id"],
    ])
      expect(Boolean(await exists(table!, column!, user.id)), table).toBe(index === 1);
  }
});
