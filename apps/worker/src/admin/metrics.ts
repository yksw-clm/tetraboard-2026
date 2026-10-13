import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import { archiveAnalytics } from "../analytics/retention";
import {
  analyticsMetricsSchema,
  type AdminAnalyticsQuery,
  type AnalyticsMetrics,
  type AdminAnalytics,
} from "@tetraboard/protocol";
import { adminAccountIds, type AdminEnv } from "./auth";
import { accountCreatedAtMsSql } from "../accounts/timestamps";
export const japanDay = (at: number) => new Date(at + 9 * 3600000).toISOString().slice(0, 10);
const metricKeys = Object.keys(analyticsMetricsSchema.shape) as (keyof AnalyticsMetrics)[];
export function emptyMetrics(): AnalyticsMetrics {
  return Object.fromEntries(
    metricKeys.map((key) => [key, key.endsWith("Rate") ? null : 0]),
  ) as AnalyticsMetrics;
}
function rates(metrics: AnalyticsMetrics) {
  metrics.startRate = metrics.conversionEligible
    ? (metrics.converted ?? 0) / metrics.conversionEligible
    : null;
  metrics.completionRate = metrics.started ? metrics.completed / metrics.started : null;
  metrics.registeredRetentionRate = metrics.registeredRetentionEligible
    ? (metrics.registeredRetained ?? 0) / metrics.registeredRetentionEligible
    : null;
  metrics.guestRetentionRate = metrics.guestRetentionEligible
    ? (metrics.guestRetained ?? 0) / metrics.guestRetentionEligible
    : null;
}
export async function readAnalytics(
  env: AdminEnv,
  query: AdminAnalyticsQuery,
): Promise<AdminAnalytics> {
  const now = Date.now();
  await archiveAnalytics(env, now);
  const from = Date.parse(`${query.from}T00:00:00+09:00`);
  const to = Date.parse(`${query.to}T00:00:00+09:00`) + 86400000;
  const include = query.includeInternal === "true";
  const game = query.game;
  const registeredAt = accountCreatedAtMsSql("u.createdAt");
  const owners = adminAccountIds(env) ?? [];
  const excludeOwners = (column: string) =>
    owners.length
      ? `(${column} IS NULL OR ${column} NOT IN (${owners.map(() => "?").join(", ")}))`
      : "1";
  const actorFilter = (alias: string) =>
    include ? "1" : `(${alias}.is_test = 0 AND ${excludeOwners(`${alias}.account_id`)})`;
  const actorArgs = () => (include ? [] : owners);
  const gameFilter = (alias: string) => (game === "all" ? "1" : `${alias}.game = ?`);
  const gameArgs = () => (game === "all" ? [] : [game]);
  const dateBucket = (column: string) =>
    `strftime('${query.bucket === "day" ? "%Y-%m-%d" : "%Y-%m"}', ${column} / 1000 + 32400, 'unixepoch')`;
  const cte = `WITH eligible_participants AS (SELECT p.*,
      CASE WHEN p.account_id IS NOT NULL THEN 'account:' || p.account_id ELSE 'guest:' || p.visitor_id END AS actor,
      CASE WHEN p.account_id IS NOT NULL THEN 'registered' ELSE 'guest' END AS kind
      FROM analytics_participants p WHERE ${actorFilter("p")}),
    eligible_matches AS (SELECT m.* FROM analytics_matches m WHERE ${gameFilter("m")}
      AND EXISTS (SELECT 1 FROM eligible_participants p WHERE p.match_id = m.id))`;
  const cteArgs = () => [...actorArgs(), ...gameArgs()];
  type Row = Record<string, number | string | null> & { period: string };
  const summary = emptyMetrics();
  const periods = new Map<string, AnalyticsMetrics>();
  for (let at = from; at < to; at += 86400000) {
    const period = japanDay(at).slice(0, query.bucket === "day" ? 10 : 7);
    if (!periods.has(period)) periods.set(period, emptyMetrics());
  }
  const jobs: { sql: string; args: (number | string)[] }[] = [];
  for (const total of [false, true]) {
    const bucket = (column: string) => (total ? "'*'" : dateBucket(column));
    const grouped = " GROUP BY period";
    jobs.push({
      sql: `SELECT ${bucket("v.started_at_ms")} AS period,
      COUNT(DISTINCT v.visitor_id) AS visitors, COUNT(*) AS pageViews, SUM(v.page='general-lobby') AS generalLobbyViews
      FROM analytics_pageviews v WHERE v.started_at_ms >= ? AND v.started_at_ms < ?
      AND ${actorFilter("v")} AND ${gameFilter("v")}${grouped}`,
      args: [from, to, ...actorArgs(), ...gameArgs()],
    });
    jobs.push({
      sql: `SELECT ${total ? "'*'" : `substr(d.day, 1, ${query.bucket === "day" ? 10 : 7})`} AS period,
      SUM(d.milliseconds) AS dwellMs, SUM(CASE WHEN v.page='general-lobby' THEN d.milliseconds ELSE 0 END) AS generalLobbyDwellMs FROM analytics_dwell d JOIN analytics_pageviews v ON v.id = d.view_id
      WHERE d.day >= ? AND d.day <= ? AND ${actorFilter("v")} AND ${gameFilter("v")}${grouped}`,
      args: [query.from, query.to, ...actorArgs(), ...gameArgs()],
    });
    jobs.push({
      sql: `SELECT period,SUM(newUsers) AS newUsers FROM (
      SELECT ${bucket(registeredAt)} AS period, COUNT(*) AS newUsers FROM user u
      WHERE COALESCE(u.isAnonymous, 0) = 0 AND (${registeredAt}) >= MAX(?, COALESCE((SELECT value FROM analytics_metadata WHERE key = 'collected_from'), ?)) AND (${registeredAt}) < ?
      ${include ? "" : `AND COALESCE(u.isTestUser, 0) = 0 AND ${excludeOwners("u.id")}`}${grouped}
      UNION ALL SELECT ${total ? "'*'" : `substr(day,1,${query.bucket === "day" ? 10 : 7})`} AS period,count AS newUsers
      FROM analytics_deleted_registrations WHERE day>=? AND day<=? AND internal=?)${grouped}`,
      args: [from, now, to, ...actorArgs(), query.from, query.to, Number(include)],
    });
    jobs.push({
      sql: `${cte} SELECT ${bucket("m.started_at_ms")} AS period, COUNT(*) AS started,
      SUM(m.status = 'completed') AS completed, SUM(m.status = 'abandoned') AS abandoned,
      SUM(m.status = 'playing') AS playing, SUM(m.cpu_count > 0) AS cpuMatches,
      SUM(m.cpu_count = 0) AS humanMatches, SUM(m.cpu_count=0 AND m.status='completed') AS humanCompleted,SUM(m.cpu_count>0 AND m.status='completed') AS cpuCompleted, SUM(m.mode = 'singles') AS singles, SUM(m.mode = 'doubles') AS doubles,
      SUM(CASE WHEN m.status = 'completed' THEN m.ended_at_ms - m.started_at_ms ELSE 0 END) AS completedDurationMs,
      SUM((COALESCE(m.ended_at_ms, ?) - m.started_at_ms) *
        (SELECT COUNT(*) FROM eligible_participants p WHERE p.match_id = m.id)) AS participationMs
      FROM eligible_matches m WHERE m.started_at_ms >= ? AND m.started_at_ms < ?${grouped}`,
      args: [...cteArgs(), now, from, to],
    });
    jobs.push({
      sql: `${cte}, participation AS (
      SELECT DISTINCT m.id, m.started_at_ms, p.actor, p.kind FROM eligible_matches m
      JOIN eligible_participants p ON p.match_id = m.id WHERE p.actor IS NOT NULL)
      SELECT ${bucket("started_at_ms")} AS period,
      COUNT(DISTINCT CASE WHEN kind = 'registered' THEN actor END) AS registeredActive,
      COUNT(DISTINCT CASE WHEN kind = 'guest' THEN actor END) AS guestActive,
      SUM(kind = 'registered') AS registeredParticipations, SUM(kind = 'guest') AS guestParticipations
      FROM participation WHERE started_at_ms >= ? AND started_at_ms < ?${grouped}`,
      args: [...cteArgs(), from, to],
    });
    jobs.push({
      sql: `${cte}, visits AS (SELECT DISTINCT v.visitor_id, v.game, v.started_at_ms,
      ${dateBucket("v.started_at_ms")} AS visit_period,
      strftime('%Y-%m-%d', v.started_at_ms / 1000 + 32400, 'unixepoch') AS day
      FROM analytics_pageviews v WHERE v.page IN ('lobby', 'room') AND v.started_at_ms >= ? AND v.started_at_ms < ?
      AND ${actorFilter("v")} AND ${gameFilter("v")})
      SELECT ${total ? "'*'" : "visit_period"} AS period, COUNT(DISTINCT v.visitor_id) AS conversionEligible,
      COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM eligible_matches m JOIN eligible_participants p ON p.match_id = m.id
        WHERE p.visitor_id = v.visitor_id AND m.game = v.game
        AND strftime('%Y-%m-%d', m.started_at_ms / 1000 + 32400, 'unixepoch') = v.day) THEN v.visitor_id END) AS converted
      FROM visits v${grouped}`,
      args: [...cteArgs(), from, to, ...actorArgs(), ...gameArgs()],
    });
    jobs.push({
      sql: `${cte}, finishes AS (
      SELECT m.id, m.game, m.ended_at_ms, p.actor, p.kind,
      ROW_NUMBER() OVER (PARTITION BY m.game, p.actor ORDER BY m.ended_at_ms, m.id) AS position
      FROM eligible_matches m JOIN eligible_participants p ON p.match_id = m.id
      WHERE m.status = 'completed' AND p.actor IS NOT NULL), cohorts AS (
      SELECT DISTINCT f.*, EXISTS (SELECT 1 FROM eligible_matches next JOIN eligible_participants p ON p.match_id = next.id
        WHERE next.game = f.game AND p.actor = f.actor AND next.id <> f.id
        AND next.started_at_ms >= f.ended_at_ms AND next.started_at_ms <= f.ended_at_ms + 604800000) AS retained
      FROM finishes f WHERE f.position = 1 AND f.ended_at_ms + 604800000 <= ?)
      SELECT ${bucket("ended_at_ms")} AS period,
      SUM(kind = 'registered') AS registeredRetentionEligible,
      SUM(kind = 'registered' AND retained) AS registeredRetained,
      SUM(kind = 'guest') AS guestRetentionEligible, SUM(kind = 'guest' AND retained) AS guestRetained
      FROM cohorts WHERE ended_at_ms >= ? AND ended_at_ms < ?${grouped}`,
      args: [...cteArgs(), now, from, to],
    });
  }
  const results = await env.APP_DB.batch<Row>([
    ...jobs.map(({ sql, args }) => env.APP_DB.prepare(sql).bind(...args)),
    env.APP_DB.prepare(
      `SELECT day, SUM(general_lobby_views) AS generalLobbyViews,SUM(general_lobby_dwell_ms) AS generalLobbyDwellMs,SUM(human_completed) AS humanCompleted,SUM(cpu_completed) AS cpuCompleted,SUM(started>0 AND human_completed IS NULL) AS missingCompletionBreakdown, SUM(page_views) AS pageViews,SUM(dwell_ms) AS dwellMs,SUM(started) AS started,SUM(completed) AS completed,SUM(abandoned) AS abandoned,SUM(cpu_matches) AS cpuMatches,SUM(human_matches) AS humanMatches,SUM(duration_ms) AS completedDurationMs,SUM(participation_ms) AS participationMs,SUM(singles) AS singles,SUM(doubles) AS doubles,SUM(incomplete) AS incomplete FROM analytics_daily WHERE day>=? AND day<=? AND internal=? ${game === "all" ? "" : "AND game=?"} GROUP BY day`,
    ).bind(query.from, query.to, Number(include), ...gameArgs()),
  ]);
  // 保存期間の集約が同時に走っても、生データと集約済みデータを同一スナップショットで読む。
  const archived = results.pop()!;
  for (const result of results)
    for (const row of result.results) {
      const target = row.period === "*" ? summary : periods.get(row.period);
      if (!target) continue;
      for (const key of metricKeys)
        if (typeof row[key] === "number") (target[key] as number | null) = row[key] as number;
    }
  for (const row of archived.results) {
    const bucket = String(row.day).slice(0, query.bucket === "day" ? 10 : 7);
    for (const target of [summary, periods.get(bucket)])
      if (target)
        for (const key of metricKeys)
          if (typeof row[key] === "number")
            (target[key] as number) = (target[key] ?? 0) + Number(row[key]);
  }
  rates(summary);
  for (const values of periods.values()) rates(values);
  for (const row of archived.results)
    if (Number(row.missingCompletionBreakdown) > 0) {
      for (const target of [
        summary,
        periods.get(String(row.day).slice(0, query.bucket === "day" ? 10 : 7)),
      ])
        if (target) {
          target.humanCompleted = null;
          target.cpuCompleted = null;
        }
    }
  for (const row of archived.results)
    if (Number(row.incomplete) > 0) {
      for (const target of [
        summary,
        periods.get(String(row.day).slice(0, query.bucket === "day" ? 10 : 7)),
      ])
        if (target) {
          target.playing = null;
          target.participationMs = null;
          target.completionRate = null;
        }
    }
  const [coverage, users] = await Promise.all([
    env.APP_DB.prepare("SELECT value FROM analytics_metadata WHERE key = 'collected_from'").first<{
      value: number;
    }>(),
    env.APP_DB.prepare(
      `SELECT COUNT(*) AS count FROM user WHERE NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=user.id) AND COALESCE(isAnonymous, 0) = 0 ${include ? "" : `AND COALESCE(isTestUser, 0) = 0 AND ${excludeOwners("id")}`}`,
    )
      .bind(...actorArgs())
      .first<{ count: number }>(),
  ]);
  const cutoff = now - analyticsRetentionMs;
  const unavailable = (values: AnalyticsMetrics) => {
    for (const key of [
      "visitors",
      "registeredActive",
      "guestActive",
      "registeredParticipations",
      "guestParticipations",
      "registeredRetentionEligible",
      "registeredRetained",
      "guestRetentionEligible",
      "guestRetained",
      "conversionEligible",
      "converted",
      "startRate",
      "registeredRetentionRate",
      "guestRetentionRate",
    ] as const)
      values[key] = null;
  };
  if (coverage && coverage.value < cutoff) {
    if (from < cutoff) unavailable(summary);
    for (const [period, values] of periods) {
      if (Date.parse(`${period.length === 7 ? period + "-01" : period}T00:00:00+09:00`) < cutoff)
        unavailable(values);
    }
    for (const values of [summary, ...periods.values()]) {
      values.registeredRetentionEligible = null;
      values.registeredRetained = null;
      values.guestRetentionEligible = null;
      values.guestRetained = null;
    }
    summary.registeredRetentionRate = null;
    summary.guestRetentionRate = null;
    for (const values of periods.values()) {
      values.registeredRetentionRate = null;
      values.guestRetentionRate = null;
    }
  }
  return {
    individualDataFromMs: cutoff,
    collectedFromMs: coverage?.value ?? null,
    asOfMs: now,
    totalUsers: users?.count ?? 0,
    summary,
    buckets: [...periods].map(([period, metrics]) => ({ period, metrics })),
  };
}
