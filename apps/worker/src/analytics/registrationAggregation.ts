import type { AdminAnalyticsQuery, RegistrationAnalyticsReport } from "@tetraboard/protocol";
import { adminAccountIds, type AdminEnv } from "../admin/auth";
const columns =
  "entry_day,day,entry,game,kind,internal,stage,utm_link_id,source,medium,campaign,referrer_class,device";
const group = "1,2,3,4,5,6,7,8,9,10,11,12,13";
function sourceQuery(include: boolean, range: string) {
  return `SELECT strftime('%Y-%m-%d',f.created_at_ms/1000+32400,'unixepoch'),strftime('%Y-%m-%d',e.occurred_at_ms/1000+32400,'unixepoch'),f.entry,f.game,f.kind,${Number(include)},e.stage,
    COALESCE(f.utm_link_id,0),COALESCE(f.utm_source,''),COALESCE(f.utm_medium,''),COALESCE(f.utm_campaign,''),
    COALESCE(f.referrer_class,''),COALESCE(f.device,''),COUNT(*)
    FROM analytics_registration_flows f JOIN analytics_registration_events e ON e.flow_id=f.id
    WHERE ${range} ${
      include
        ? ""
        : `AND f.is_test=0
      AND (f.source_account_id IS NULL OR f.source_account_id NOT IN(SELECT value FROM json_each(?)))
      AND (f.target_account_id IS NULL OR f.target_account_id NOT IN(SELECT value FROM json_each(?)))`
    }
    GROUP BY ${group}`;
}
export async function aggregateRegistrationAnalytics(env: AdminEnv, now = Date.now()) {
  const db = env.APP_DB,
    owners = JSON.stringify(adminAccountIds(env) ?? []);
  const dirty = (
    await db
      .prepare("SELECT day,revision FROM analytics_registration_dirty_days ORDER BY day LIMIT 16")
      .all<{ day: string; revision: number }>()
  ).results;
  const statements: D1PreparedStatement[] = [];
  for (const { day, revision } of dirty) {
    const from = Date.parse(`${day}T00:00:00+09:00`),
      to = from + 86400000;
    statements.push(
      db.prepare("DELETE FROM analytics_registration_daily WHERE entry_day=?").bind(day),
    );
    for (const include of [false, true]) {
      const fresh = sourceQuery(include, "f.created_at_ms>=? AND f.created_at_ms<?");
      statements.push(
        db
          .prepare(`WITH combined(${columns},count) AS (${fresh} UNION ALL
        SELECT * FROM analytics_registration_archive WHERE entry_day=? AND internal=?)
        INSERT INTO analytics_registration_daily SELECT ${columns},SUM(count) FROM combined
        GROUP BY ${group}`)
          .bind(from, to, ...(include ? [] : [owners, owners]), day, Number(include)),
      );
    }
    statements.push(
      db
        .prepare("DELETE FROM analytics_registration_dirty_days WHERE day=? AND revision=?")
        .bind(day, revision),
    );
  }
  statements.push(
    db
      .prepare(`INSERT INTO analytics_metadata(key,value)
    SELECT 'registration_aggregated_at',? WHERE NOT EXISTS(SELECT 1 FROM analytics_registration_dirty_days)
    ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)`)
      .bind(now),
  );
  await db.batch(statements);
}

/** 起点から90日で対応表を消し、IDを持たない段階別件数だけを残します。 */
export function registrationArchiveStatements(env: Env, cutoff: number, now: number) {
  const db = env.APP_DB,
    owners = JSON.stringify(adminAccountIds(env as AdminEnv) ?? []);
  return [
    ...[false, true].map((include) =>
      db
        .prepare(`INSERT INTO analytics_registration_archive
      ${sourceQuery(include, "f.created_at_ms<=?")}
      ON CONFLICT(${columns}) DO UPDATE SET count=count+excluded.count`)
        .bind(cutoff, ...(include ? [] : [owners, owners])),
    ),
    db.prepare("DELETE FROM analytics_registration_flows WHERE created_at_ms<=?").bind(cutoff),
    db.prepare("DELETE FROM analytics_registration_attempts WHERE expires_at_ms<=?").bind(now),
    db.prepare("DELETE FROM analytics_registration_deleted_flows WHERE expires_at_ms<=?").bind(now),
  ];
}
export async function readRegistrationAnalytics(
  env: Env,
  query: AdminAnalyticsQuery & { dateBasis?: "entry" | "event" },
  now = Date.now(),
): Promise<RegistrationAnalyticsReport> {
  const [metadata, data] = await env.APP_DB.batch<Record<string, unknown>>([
    env.APP_DB.prepare(
      "SELECT key,value FROM analytics_metadata WHERE key IN('registration_collected_from','registration_aggregated_at')",
    ),
    env.APP_DB.prepare(`SELECT * FROM analytics_registration_daily WHERE ${query.dateBasis === "event" ? "day" : "entry_day"}>=? AND ${query.dateBasis === "event" ? "day" : "entry_day"}<=? AND internal=? ${query.game === "all" ? "" : "AND game=?"}
      ORDER BY entry_day,day,entry,game,kind,stage,utm_link_id,source,medium,campaign,referrer_class,device`).bind(
      query.from,
      query.to,
      Number(query.includeInternal === "true"),
      ...(query.game === "all" ? [] : [query.game]),
    ),
  ]);
  const values = new Map(metadata!.results.map((row) => [String(row.key), Number(row.value)]));
  const at = values.get("registration_aggregated_at") ?? null;
  return {
    collectedFromMs: values.get("registration_collected_from")!,
    aggregatedAtMs: at,
    metricVersion: 1,
    dateBasis: query.dateBasis ?? "entry",
    status: at === null ? "unmeasured" : now - at > 300000 ? "delayed" : "ready",
    rows: data!.results.map((row) => ({
      day: String(row.day),
      entryDay: String(row.entry_day),
      entry: row.entry as RegistrationAnalyticsReport["rows"][number]["entry"],
      game: row.game as RegistrationAnalyticsReport["rows"][number]["game"],
      kind: row.kind as RegistrationAnalyticsReport["rows"][number]["kind"],
      stage: row.stage as RegistrationAnalyticsReport["rows"][number]["stage"],
      linkId: Number(row.utm_link_id) || null,
      source: String(row.source),
      medium: String(row.medium),
      campaign: String(row.campaign),
      referrerClass: String(row.referrer_class),
      device: String(row.device),
      count: Number(row.count),
    })),
  };
}
