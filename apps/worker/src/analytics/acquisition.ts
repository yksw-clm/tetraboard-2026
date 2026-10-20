import {
  type AcquisitionReport,
  type AcquisitionRow,
  type AdminAnalyticsQuery,
} from "@tetraboard/protocol";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import { adminAccountIds, type AdminEnv } from "../admin/auth";

const dimensions = [
  { name: "referrer", column: "referrer_class" },
  { name: "utm", column: "utm_source" },
  { name: "device", column: "device" },
] as const;
function keys(alias: string, dimension: (typeof dimensions)[number]) {
  return `COALESCE(${alias}.${dimension.column},'') AS value,${
    dimension.name === "utm"
      ? `COALESCE(${alias}.utm_medium,'') AS medium,COALESCE(${alias}.utm_campaign,'') AS campaign`
      : "'' AS medium,'' AS campaign"
  }`;
}
const day = (column: string) => `strftime('%Y-%m-%d',${column}/1000+32400,'unixepoch')`;
const coverage =
  "COALESCE((SELECT value FROM analytics_metadata WHERE key='acquisition_collected_from'),9223372036854775807)";
function actorFilter(alias: string, include: boolean, owners: string[]) {
  return `${include ? "1" : `${alias}.is_test=0 ${owners.length ? `AND (${alias}.account_id IS NULL OR ${alias}.account_id NOT IN (${owners.map(() => "?").join(",")}))` : ""}`}
    AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=${alias}.account_id)`;
}

export function acquisitionArchiveStatements(env: AdminEnv, cutoff: number) {
  const db = env.APP_DB,
    owners = adminAccountIds(env) ?? [];
  const statements: D1PreparedStatement[] = [];
  for (const include of [false, true])
    for (const dimension of dimensions) {
      const args = include ? [] : owners;
      statements.push(
        db
          .prepare(`INSERT INTO analytics_acquisition_daily(day,game,internal,dimension,value,medium,campaign,visits)
      SELECT day,game,?,'${dimension.name}',value,medium,campaign,COUNT(*) FROM (
        SELECT ${day("v.started_at_ms")} AS day,v.game,${keys("s", dimension)}
        FROM analytics_session_visits v JOIN analytics_sessions s ON s.id=v.session_id
        WHERE s.started_at_ms<=? AND v.started_at_ms>=${coverage} AND ${actorFilter("v", include, owners)})
      GROUP BY day,game,value,medium,campaign
      ON CONFLICT(day,game,internal,dimension,value,medium,campaign) DO UPDATE SET visits=visits+excluded.visits`)
          .bind(Number(include), cutoff, ...args),
      );
      statements.push(
        db
          .prepare(`INSERT INTO analytics_acquisition_daily(day,game,internal,dimension,value,medium,campaign,started)
      SELECT day,game,?,'${dimension.name}',value,medium,campaign,COUNT(DISTINCT id) FROM (
        SELECT m.id,${day("m.started_at_ms")} AS day,CASE scope.all_games WHEN 1 THEN '*' ELSE m.game END AS game,${keys("p", dimension)}
        FROM analytics_matches m JOIN analytics_participants p ON p.match_id=m.id
        CROSS JOIN (SELECT 0 AS all_games UNION ALL SELECT 1) scope
        WHERE m.started_at_ms<=? AND m.started_at_ms>=${coverage} AND ${actorFilter("p", include, owners)})
      GROUP BY day,game,value,medium,campaign
      ON CONFLICT(day,game,internal,dimension,value,medium,campaign) DO UPDATE SET started=started+excluded.started`)
          .bind(Number(include), cutoff, ...args),
      );
    }
  statements.push(db.prepare("DELETE FROM analytics_sessions WHERE started_at_ms<=?").bind(cutoff));
  return statements;
}

export async function readAcquisition(
  env: AdminEnv,
  query: AdminAnalyticsQuery,
  now: number,
): Promise<AcquisitionReport> {
  const db = env.APP_DB,
    owners = adminAccountIds(env) ?? [],
    include = query.includeInternal === "true";
  const from = Date.parse(`${query.from}T00:00:00+09:00`),
    to = Date.parse(`${query.to}T00:00:00+09:00`) + 86400000;
  const cutoff = now - analyticsRetentionMs,
    args = include ? [] : owners;
  const statements: D1PreparedStatement[] = [];
  for (const dimension of dimensions) {
    statements.push(
      db
        .prepare(`SELECT day,'${dimension.name}' AS dimension,value,medium,campaign,COUNT(*) AS visits,0 AS started FROM (
      SELECT ${day("v.started_at_ms")} AS day,${keys("s", dimension)}
      FROM analytics_session_visits v JOIN analytics_sessions s ON s.id=v.session_id
      WHERE s.started_at_ms>? AND v.started_at_ms>=? AND v.started_at_ms<? AND v.started_at_ms>=${coverage}
        AND v.game=? AND ${actorFilter("v", include, owners)}) GROUP BY day,value,medium,campaign`)
        .bind(cutoff, from, to, query.game === "all" ? "*" : query.game, ...args),
    );
    statements.push(
      db
        .prepare(`SELECT day,'${dimension.name}' AS dimension,value,medium,campaign,0 AS visits,COUNT(DISTINCT id) AS started FROM (
      SELECT m.id,${day("m.started_at_ms")} AS day,${keys("p", dimension)}
      FROM analytics_matches m JOIN analytics_participants p ON p.match_id=m.id
      WHERE m.started_at_ms>? AND m.started_at_ms>=? AND m.started_at_ms<? AND m.started_at_ms>=${coverage}
        ${query.game === "all" ? "" : "AND m.game=?"} AND ${actorFilter("p", include, owners)}) GROUP BY day,value,medium,campaign`)
        .bind(cutoff, from, to, ...(query.game === "all" ? [] : [query.game]), ...args),
    );
  }
  statements.push(
    db
      .prepare(`SELECT day,dimension,value,medium,campaign,visits,started FROM analytics_acquisition_daily
    WHERE day>=? AND day<=? AND game=? AND internal=?`)
      .bind(query.from, query.to, query.game === "all" ? "*" : query.game, Number(include)),
  );
  statements.push(
    db.prepare("SELECT value FROM analytics_metadata WHERE key='acquisition_collected_from'"),
  );
  // 個別行の集約・削除が競合しても、両方を同じスナップショットで取得します。
  const results = await db.batch<AcquisitionRow & { day: string }>(statements);
  const measured = results.pop()!.results[0];
  const summary = new Map<string, AcquisitionRow>(),
    periods = new Map<string, Map<string, AcquisitionRow>>();
  for (let at = from; at < to; at += 86400000) {
    const period = new Date(at + 32400000).toISOString().slice(0, query.bucket === "day" ? 10 : 7);
    if (!periods.has(period)) periods.set(period, new Map());
  }
  for (const result of results)
    for (const row of result.results) {
      const period = row.day.slice(0, query.bucket === "day" ? 10 : 7);
      for (const target of [summary, periods.get(period)])
        if (target) {
          const key = JSON.stringify([row.dimension, row.value, row.medium, row.campaign]);
          const previous = target.get(key);
          target.set(key, {
            dimension: row.dimension,
            value: row.value,
            medium: row.medium,
            campaign: row.campaign,
            visits: (previous?.visits ?? 0) + row.visits,
            started: (previous?.started ?? 0) + row.started,
          });
        }
    }
  const ordered = (rows: Map<string, AcquisitionRow>) =>
    [...rows.values()].sort(
      (a, b) =>
        a.dimension.localeCompare(b.dimension) ||
        b.visits - a.visits ||
        b.started - a.started ||
        a.value.localeCompare(b.value) ||
        a.medium.localeCompare(b.medium) ||
        a.campaign.localeCompare(b.campaign),
    );
  return {
    collectedFromMs: measured ? Number(measured.value) : null,
    summary: ordered(summary),
    buckets: [...periods].map(([period, rows]) => ({ period, rows: ordered(rows) })),
  };
}
