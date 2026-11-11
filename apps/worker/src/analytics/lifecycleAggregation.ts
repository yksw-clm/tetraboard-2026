import { adminAccountIds, type AdminEnv } from "../admin/auth";
const columns = "day,game,internal,scope,kind,reason,humans";
const group = "1,2,3,4,5,6,7";
const day = (column: string) => `strftime('%Y-%m-%d',${column}/1000+32400,'unixepoch')`;
const ratingTables = [
  ["shogi", "shogi"],
  ["reversi", "reversi"],
  ["four-shogi", "four_shogi"],
  ["four-reversi", "four_reversi"],
];
// 棋譜が存在してもレートの保存待ちがある間は、集計対象外と確定しません。
function ratingReason() {
  return `CASE WHEN m.status='abandoned' THEN 'abandoned' WHEN m.status!='completed' OR saved.id IS NULL THEN 'pending' ${ratingTables
    .map(
      ([game, table]) => `WHEN m.game='${game}' THEN CASE
    WHEN EXISTS(SELECT 1 FROM ${table}_rating_pending r WHERE r.match_id=m.id) THEN 'pending'
    WHEN EXISTS(SELECT 1 FROM ${table}_rating_changes r WHERE r.match_id=m.id) THEN 'included'
    WHEN COALESCE(json_extract(saved.record_json,'$.rating.usedFallback'),json_extract(saved.record_json,'$.fourShogiRating.usedFallback'),json_extract(saved.record_json,'$.fourReversiRating.usedFallback'),0)=1 THEN 'ai_fallback'
    ELSE 'unavailable' END`,
    )
    .join(" ")} ELSE 'unavailable' END`;
}
function eligible(include: boolean, alias: string) {
  return include
    ? "1"
    : `${alias}.is_test=0 AND (${alias}.account_id IS NULL OR ${alias}.account_id NOT IN(SELECT value FROM json_each((SELECT value FROM owners))))`;
}
function sources(include: boolean, range: string) {
  const person = eligible(include, "p"),
    event = eligible(include, "e");
  return `SELECT ${day("e.at_ms")},e.game,${Number(include)},'search_'||e.stage,CASE WHEN e.rated=1 THEN 'rated' ELSE 'normal' END,
    COALESCE(e.reason,''),COALESCE(e.humans,0),COUNT(*),COALESCE(SUM(e.waiting_ms),0),COUNT(e.waiting_ms)
    FROM analytics_matchmaking_events e WHERE ${range.replaceAll("TIME", "e.at_ms")} AND ${event} GROUP BY ${group}
  UNION ALL SELECT ${day("m.started_at_ms")},m.game,${Number(include)},'match_'||m.status,m.match_kind,COALESCE(m.end_reason,''),COALESCE(m.human_count,0),COUNT(*),0,0
    FROM analytics_matches m WHERE m.match_kind!='unknown' AND ${range.replaceAll("TIME", "m.started_at_ms")} AND EXISTS(SELECT 1 FROM analytics_participants p WHERE p.match_id=m.id AND ${person}) GROUP BY ${group}
  UNION ALL SELECT ${day("m.started_at_ms")},m.game,${Number(include)},'participant_end',m.match_kind,p.end_reason,COALESCE(m.human_count,0),COUNT(*),0,0
    FROM analytics_matches m JOIN analytics_participants p ON p.match_id=m.id WHERE m.match_kind!='unknown' AND p.end_reason IS NOT NULL AND ${range.replaceAll("TIME", "m.started_at_ms")} AND ${person} GROUP BY ${group}
  UNION ALL SELECT ${day("m.started_at_ms")},m.game,${Number(include)},'rating',m.match_kind,${ratingReason()},COALESCE(m.human_count,0),COUNT(*),0,0
    FROM analytics_matches m LEFT JOIN matches saved ON saved.id=m.id WHERE m.match_kind='rated' AND ${range.replaceAll("TIME", "m.started_at_ms")} AND EXISTS(SELECT 1 FROM analytics_participants p WHERE p.match_id=m.id AND ${person}) GROUP BY ${group}`;
}
function bindRange(range: number[]) {
  return [...range, ...range, ...range, ...range];
}
export async function aggregateLifecycleAnalytics(env: AdminEnv, now = Date.now()) {
  const db = env.APP_DB,
    owners = JSON.stringify(adminAccountIds(env) ?? []);
  const dirty = (
    await db
      .prepare("SELECT day,revision FROM analytics_lifecycle_dirty_days ORDER BY day LIMIT 16")
      .all<{ day: string; revision: number }>()
  ).results;
  const statements: D1PreparedStatement[] = [];
  for (const { day, revision } of dirty) {
    const from = Date.parse(`${day}T00:00:00+09:00`),
      to = from + 86400000;
    statements.push(db.prepare("DELETE FROM analytics_lifecycle_daily WHERE day=?").bind(day));
    for (const include of [false, true])
      statements.push(
        db
          .prepare(`WITH owners(value) AS (SELECT ?), combined(${columns},count,waiting_ms,waiting_samples) AS (
      ${sources(include, "TIME>=? AND TIME<?")} UNION ALL SELECT * FROM analytics_lifecycle_archive WHERE day=? AND internal=?)
      INSERT INTO analytics_lifecycle_daily SELECT ${columns},SUM(count),SUM(waiting_ms),SUM(waiting_samples) FROM combined GROUP BY ${group}`)
          .bind(owners, ...bindRange([from, to]), day, Number(include)),
      );
    statements.push(
      db
        .prepare("DELETE FROM analytics_lifecycle_dirty_days WHERE day=? AND revision=?")
        .bind(day, revision),
    );
  }
  statements.push(
    db
      .prepare(`INSERT INTO analytics_metadata(key,value) SELECT 'lifecycle_aggregated_at',? WHERE NOT EXISTS(SELECT 1 FROM analytics_lifecycle_dirty_days)
    ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)`)
      .bind(now),
  );
  await db.batch(statements);
}
/** 個別の操作・局・席の対応は90日以内とし、IDのない件数と待ち時間の合計だけを残します。 */
export function lifecycleArchiveStatements(env: Env, cutoff: number) {
  const db = env.APP_DB,
    owners = JSON.stringify(adminAccountIds(env as AdminEnv) ?? []);
  return [
    ...[false, true].map((include) =>
      db
        .prepare(`WITH owners(value) AS (SELECT ?) INSERT INTO analytics_lifecycle_archive
      ${sources(include, "TIME<=?")}
      ON CONFLICT(${columns}) DO UPDATE SET count=count+excluded.count,waiting_ms=waiting_ms+excluded.waiting_ms,waiting_samples=waiting_samples+excluded.waiting_samples`)
        .bind(owners, ...bindRange([cutoff])),
    ),
    db.prepare("DELETE FROM analytics_matchmaking_events WHERE at_ms<=?").bind(cutoff),
  ];
}
