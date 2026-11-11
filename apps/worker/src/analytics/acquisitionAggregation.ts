import { acquisitionSnapshotSchema, type AdminAnalyticsQuery } from "@tetraboard/protocol";
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import { adminAccountIds, type AdminEnv } from "../admin/auth";
const dims =
  '(SELECT value AS dimension FROM json_each(\'["referrer","utm","device","link","host"]\'))';
const value = (a: string) =>
  `COALESCE(CASE d.dimension WHEN 'referrer' THEN ${a}.referrer_class WHEN 'utm' THEN ${a}.utm_source WHEN 'device' THEN ${a}.device WHEN 'link' THEN CAST(${a}.utm_link_id AS TEXT) ${a === "s" ? "WHEN 'host' THEN s.referrer_host" : ""} END,'')`;
const extra = (a: string, key: string) =>
  `CASE WHEN d.dimension IN('utm','link') THEN COALESCE(${a}.utm_${key},'') ELSE '' END`;
const eligible = (a: string) =>
  `NOT EXISTS(SELECT 1 FROM deleted_accounts WHERE id=${a}.account_id) AND (scope.internal=1 OR (${a}.is_test=0 AND (${a}.account_id IS NULL OR ${a}.account_id NOT IN(SELECT value FROM json_each(?)))))`;
export async function aggregateAcquisition(env: AdminEnv, now = Date.now()) {
  const db = env.APP_DB,
    owners = JSON.stringify(adminAccountIds(env) ?? []);
  const dirty = (
    await db
      .prepare("SELECT day,revision FROM analytics_acquisition_dirty_days ORDER BY day LIMIT 16")
      .all<{ day: string; revision: number }>()
  ).results;
  const statements: D1PreparedStatement[] = [];
  for (const { day, revision } of dirty) {
    const from = Date.parse(`${day}T00:00:00+09:00`),
      to = from + 86400000,
      cutoff = now - analyticsRetentionMs;
    statements.push(db.prepare("DELETE FROM analytics_acquisition_snapshot WHERE day=?").bind(day));
    statements.push(
      db
        .prepare(`INSERT INTO analytics_acquisition_snapshot
   SELECT ?,game,internal,dimension,value,medium,campaign,SUM(visits),SUM(started) FROM (
    SELECT CASE v.game WHEN '*' THEN 'all' ELSE v.game END AS game,scope.internal,d.dimension,${value("s")} AS value,${extra("s", "medium")} AS medium,${extra("s", "campaign")} AS campaign,COUNT(*) AS visits,0 AS started
    FROM analytics_session_visits v JOIN analytics_sessions s ON s.id=v.session_id CROSS JOIN (SELECT 0 AS internal UNION ALL SELECT 1) scope CROSS JOIN ${dims} d
    WHERE v.started_at_ms>=COALESCE((SELECT value FROM analytics_metadata WHERE key='acquisition_collected_from'),9223372036854775807) AND v.started_at_ms>=? AND v.started_at_ms<? AND s.started_at_ms>? AND ${eligible("v")} GROUP BY 1,2,3,4,5,6
    UNION ALL
    SELECT CASE games.all_games WHEN 1 THEN 'all' ELSE m.game END,scope.internal,d.dimension,${value("p")},${extra("p", "medium")},${extra("p", "campaign")},0,COUNT(DISTINCT m.id)
    FROM analytics_matches m JOIN analytics_participants p ON p.match_id=m.id CROSS JOIN (SELECT 0 AS internal UNION ALL SELECT 1) scope CROSS JOIN (SELECT 0 AS all_games UNION ALL SELECT 1) games CROSS JOIN ${dims} d
    WHERE d.dimension!='host' AND m.started_at_ms>=COALESCE((SELECT value FROM analytics_metadata WHERE key='acquisition_collected_from'),9223372036854775807) AND m.started_at_ms>=? AND m.started_at_ms<? AND m.started_at_ms>? AND ${eligible("p")} GROUP BY 1,2,3,4,5,6
    UNION ALL SELECT CASE game WHEN '*' THEN 'all' ELSE game END,internal,dimension,value,medium,campaign,visits,started FROM analytics_acquisition_daily WHERE day=?
   ) GROUP BY 1,2,3,4,5,6,7`)
        .bind(day, from, to, cutoff, owners, from, to, cutoff, owners, day),
    );
    statements.push(
      db
        .prepare("DELETE FROM analytics_acquisition_dirty_days WHERE day=? AND revision=?")
        .bind(day, revision),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO analytics_metadata(key,value) SELECT 'acquisition_aggregated_at',? WHERE NOT EXISTS(SELECT 1 FROM analytics_acquisition_dirty_days) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)`,
      )
      .bind(now),
  );
  await db.batch(statements);
}
export async function readAcquisitionSnapshot(env: Env, q: AdminAnalyticsQuery, now = Date.now()) {
  const [meta, rows] = await env.APP_DB.batch<Record<string, unknown>>([
    env.APP_DB.prepare(
      "SELECT key,value FROM analytics_metadata WHERE key IN('acquisition_collected_from','acquisition_aggregated_at')",
    ),
    env.APP_DB.prepare(`SELECT s.dimension,s.value,s.medium,s.campaign,SUM(visits) AS visits,SUM(started) AS started,l.label
 FROM analytics_acquisition_snapshot s LEFT JOIN analytics_links l ON s.dimension='link' AND CAST(l.id AS TEXT)=s.value
 WHERE s.day>=? AND s.day<=? AND s.game=? AND s.internal=? AND (s.dimension!='host' OR s.day>?)
 GROUP BY s.dimension,s.value,s.medium,s.campaign,l.label ORDER BY s.dimension,visits DESC,s.value,s.medium,s.campaign`).bind(
      q.from,
      q.to,
      q.game,
      Number(q.includeInternal === "true"),
      new Date(now - analyticsRetentionMs + 32400000).toISOString().slice(0, 10),
    ),
  ]);
  const values = new Map(meta!.results.map((r) => [String(r.key), Number(r.value)]));
  const at = values.get("acquisition_aggregated_at") ?? null;
  return acquisitionSnapshotSchema.parse({
    collectedFromMs: values.get("acquisition_collected_from") ?? null,
    aggregatedAtMs: at,
    metricVersion: 1,
    status: at === null ? "unmeasured" : now - at > 300000 ? "delayed" : "ready",
    hostAvailable:
      q.from > new Date(now - analyticsRetentionMs + 32400000).toISOString().slice(0, 10),
    rows:
      at === null
        ? []
        : rows!.results.map((r) => ({
            ...r,
            started: r.dimension === "host" ? null : r.started,
            label: r.label ?? null,
          })),
  });
}
