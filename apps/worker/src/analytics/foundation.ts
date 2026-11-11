import { aggregateRegistrationAnalytics } from "./registrationAggregation";
import {
  gameScopeIds,
  type AdminAnalyticsQuery,
  type AnalyticsFoundation,
} from "@tetraboard/protocol";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import { adminAccountIds, type AdminEnv } from "../admin/auth";

const dayOf = (ms: number) => new Date(ms + 32400000).toISOString().slice(0, 10);
const dayMs = (day: string) => Date.parse(`${day}T00:00:00+09:00`);
type State = {
  collected_from_ms: number;
  aggregated_at_ms: number | null;
  metric_version: number;
  backfill_cursor: string;
  backfill_complete: number;
};

/** 本人履歴の索引を使い、再開位置以降のアカウントと変更された本人だけを復元します。 */
export async function backfillAccountTotals(db: D1Database, limit = 50) {
  const state = await db
    .prepare("SELECT * FROM analytics_foundation_state WHERE id=1")
    .first<State>();
  if (!state) throw new Error("Analytics foundation missing");
  const users = state.backfill_complete
    ? []
    : (
        await db
          .prepare("SELECT id FROM user WHERE id>? ORDER BY id LIMIT ?")
          .bind(state.backfill_cursor, limit)
          .all<{ id: string }>()
      ).results;
  const dirty = (
    await db
      .prepare("SELECT account_id FROM account_totals_dirty ORDER BY account_id LIMIT ?")
      .bind(limit)
      .all<{ account_id: string }>()
  ).results;
  const accounts = [...new Set([...users.map((u) => u.id), ...dirty.map((u) => u.account_id)])];
  await db.batch([
    ...accounts.flatMap((id) => [
      db.prepare("DELETE FROM account_game_totals WHERE account_id=?").bind(id),
      db
        .prepare(`INSERT INTO account_game_totals
        SELECT h.account_id,m.game,COUNT(*),MIN(m.ended_at_ms),MAX(m.ended_at_ms)
        FROM account_match_history h JOIN matches m ON m.id=h.match_id
        WHERE h.account_id=? AND EXISTS(SELECT 1 FROM user WHERE id=h.account_id)
          AND NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=h.account_id)
          AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=h.account_id)
        GROUP BY h.account_id,m.game`)
        .bind(id),
      db.prepare("DELETE FROM account_totals_dirty WHERE account_id=?").bind(id),
    ]),
    // 同時実行が古いカーソルを書き戻さないよう比較してから進めます。
    db
      .prepare(`UPDATE analytics_foundation_state SET backfill_cursor=?,backfill_complete=?
      WHERE id=1 AND backfill_cursor=? AND backfill_complete=0`)
      .bind(
        users.at(-1)?.id ?? state.backfill_cursor,
        Number(users.length < limit),
        state.backfill_cursor,
      ),
  ]);
}

function dailyStatement(
  db: D1Database,
  day: string,
  game: string,
  include: boolean,
  owners: string[],
) {
  const start = dayMs(day),
    end = start + 86400000;
  const eligible = (alias: string) =>
    include
      ? "1"
      : `${alias}.is_test=0
    AND (${alias}.account_id IS NULL OR ${alias}.account_id NOT IN (SELECT account_id FROM excluded))`;
  const scope = (alias: string) => (game === "all" ? "1" : `${alias}.game=?`);
  const args = () => (game === "all" ? [] : [game]);
  return db
    .prepare(`WITH excluded AS (SELECT value AS account_id FROM json_each(?)), views AS (
      SELECT v.* FROM analytics_pageviews v WHERE v.started_at_ms>=MAX(?,(SELECT collected_from_ms FROM analytics_foundation_state WHERE id=1))
        AND v.started_at_ms<? AND ${eligible("v")} AND ${scope("v")}
    ), candidates AS (SELECT m.* FROM analytics_matches m WHERE m.started_at_ms>=MAX(?,(SELECT collected_from_ms FROM analytics_foundation_state WHERE id=1))
      AND m.started_at_ms<? AND ${scope("m")}),
    players AS (SELECT p.* FROM candidates c JOIN analytics_participants p ON p.match_id=c.id WHERE ${eligible("p")}),
    games AS (SELECT c.* FROM candidates c WHERE EXISTS(SELECT 1 FROM players p WHERE p.match_id=c.id)),
    dwell AS (SELECT COALESCE(SUM(d.milliseconds),0) AS total FROM analytics_dwell d
      JOIN analytics_pageviews v ON v.id=d.view_id WHERE d.day=?
        AND v.started_at_ms>=(SELECT collected_from_ms FROM analytics_foundation_state WHERE id=1)
        AND ${eligible("v")} AND ${scope("v")})
    INSERT INTO analytics_daily_v2
    SELECT ?,?,?,(SELECT COUNT(*) FROM views),(SELECT COUNT(DISTINCT visitor_id) FROM views),
      (SELECT total FROM dwell),COUNT(*),COALESCE(SUM(status='completed'),0),COALESCE(SUM(status='abandoned'),0),
      COALESCE(SUM(cpu_count>0),0),COALESCE(SUM(cpu_count=0),0),
      COALESCE(SUM(CASE WHEN status='completed' THEN ended_at_ms-started_at_ms ELSE 0 END),0),
      (SELECT COUNT(DISTINCT p.origin_account_id) FROM players p JOIN games m ON m.id=p.match_id WHERE p.is_guest=0),
      (SELECT COUNT(DISTINCT p.origin_account_id) FROM players p JOIN games m ON m.id=p.match_id WHERE p.is_guest=1),0
    FROM games WHERE 1 ON CONFLICT(day,game,internal) DO UPDATE SET
      page_views=excluded.page_views,visitors=excluded.visitors,dwell_ms=excluded.dwell_ms,
      started=excluded.started,completed=excluded.completed,abandoned=excluded.abandoned,
      cpu_matches=excluded.cpu_matches,human_matches=excluded.human_matches,
      completed_duration_ms=excluded.completed_duration_ms,
      registered_active=excluded.registered_active,guest_active=excluded.guest_active,incomplete=0`)
    .bind(
      JSON.stringify(owners),
      start,
      end,
      ...args(),
      start,
      end,
      ...(game === "all" ? [] : [game]),
      day,
      ...args(),
      day,
      game,
      Number(include),
    );
}

/** 各日を同一トランザクションで公開し、途中失敗で古い値と処理済み位置を壊しません。 */
export async function aggregateAnalytics(env: AdminEnv, now = Date.now()) {
  const db = env.APP_DB;
  const state = await db
    .prepare("SELECT * FROM analytics_foundation_state WHERE id=1")
    .first<State>();
  if (!state) throw new Error("Analytics foundation missing");
  const dirty = (
    await db
      .prepare("SELECT day,revision FROM analytics_dirty_days ORDER BY day LIMIT 16")
      .all<{ day: string; revision: number }>()
  ).results;
  const owners = adminAccountIds(env) ?? [];
  const statements: D1PreparedStatement[] = [];
  for (const { day, revision } of dirty) {
    if (day >= dayOf(state.collected_from_ms))
      for (const game of gameScopeIds)
        for (const include of [false, true]) {
          statements.push(dailyStatement(db, day, game, include, owners));
          const additive = [
            "page_views",
            "dwell_ms",
            "started",
            "completed",
            "abandoned",
            "cpu_matches",
            "human_matches",
            "completed_duration_ms",
            "incomplete",
          ];
          statements.push(
            db
              .prepare(`UPDATE analytics_daily_v2 SET ${additive.map((key) => `${key}=${key}+COALESCE((SELECT ${key} FROM analytics_foundation_archive a WHERE a.day=analytics_daily_v2.day AND a.game=analytics_daily_v2.game AND a.internal=analytics_daily_v2.internal),0)`).join(",")}
            WHERE day=? AND game=? AND internal=?`)
              .bind(day, game, Number(include)),
          );
        }
    statements.push(
      db.prepare("DELETE FROM analytics_dirty_days WHERE day=? AND revision=?").bind(day, revision),
    );
  }
  statements.push(
    db
      .prepare(`UPDATE analytics_foundation_state SET aggregated_at_ms=MAX(COALESCE(aggregated_at_ms,0),?)
    WHERE id=1 AND NOT EXISTS(SELECT 1 FROM analytics_dirty_days)`)
      .bind(now),
  );
  await db.batch(statements);
}

export async function runAnalyticsAggregation(env: Env, now = Date.now()) {
  await backfillAccountTotals(env.APP_DB);
  await aggregateRegistrationAnalytics(env, now);
  await aggregateAnalytics(env, now);
}

export async function readAnalyticsFoundation(
  env: Env,
  query: AdminAnalyticsQuery,
  now = Date.now(),
): Promise<AnalyticsFoundation> {
  const [stateResult, daysResult] = await env.APP_DB.batch<Record<string, unknown>>([
    env.APP_DB.prepare("SELECT * FROM analytics_foundation_state WHERE id=1"),
    env.APP_DB.prepare(
      `SELECT * FROM analytics_daily_v2 WHERE day>=? AND day<=? AND game=? AND internal=? ORDER BY day`,
    ).bind(query.from, query.to, query.game, Number(query.includeInternal === "true")),
  ]);
  const state = stateResult!.results[0] as unknown as State;
  return {
    collectedFromMs: state.collected_from_ms,
    aggregatedAtMs: state.aggregated_at_ms,
    metricVersion: state.metric_version,
    status:
      state.aggregated_at_ms === null
        ? "unmeasured"
        : now - state.aggregated_at_ms > 300000
          ? "delayed"
          : "ready",
    backfillComplete: Boolean(state.backfill_complete),
    days: daysResult!.results.map((row) => ({
      day: String(row.day),
      incomplete: Boolean(row.incomplete),
      pageViews: Number(row.page_views),
      visitors: String(row.day) <= dayOf(now - analyticsRetentionMs) ? null : Number(row.visitors),
      dwellMs: Number(row.dwell_ms),
      started: Number(row.started),
      completed: Number(row.completed),
      abandoned: Number(row.abandoned),
      cpuMatches: Number(row.cpu_matches),
      humanMatches: Number(row.human_matches),
      completedDurationMs: Number(row.completed_duration_ms),
      registeredActive:
        String(row.day) <= dayOf(now - analyticsRetentionMs) ? null : Number(row.registered_active),
      guestActive:
        String(row.day) <= dayOf(now - analyticsRetentionMs) ? null : Number(row.guest_active),
    })),
  };
}
