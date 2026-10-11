import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import { adminAccountIds, type AdminEnv } from "../admin/auth";
export async function archiveAnalytics(env: Env, now = Date.now()) {
  const db = env.APP_DB,
    cutoff = now - analyticsRetentionMs;
  const owners = adminAccountIds(env as AdminEnv) ?? [];
  const day = (column: string) => `strftime('%Y-%m-%d',${column}/1000+32400,'unixepoch')`;
  const statements: D1PreparedStatement[] = [];
  for (const include of [false, true]) {
    const eligible = (alias: string) =>
      include
        ? "1"
        : `${alias}.is_test = 0 ${owners.length ? `AND (${alias}.account_id IS NULL OR ${alias}.account_id NOT IN (${owners.map(() => "?").join(",")}))` : ""}`;
    const args = include ? [] : owners;
    statements.push(
      db
        .prepare(`INSERT INTO analytics_daily(day,game,internal,page_views,dwell_ms)
      SELECT ${day("v.started_at_ms")},COALESCE(v.game,''),?,COUNT(*),0
      FROM analytics_pageviews v WHERE started_at_ms<=? AND ${eligible("v")} GROUP BY 1,2,3
      ON CONFLICT(day,game,internal) DO UPDATE SET page_views=page_views+excluded.page_views,dwell_ms=dwell_ms+excluded.dwell_ms`)
        .bind(Number(include), cutoff, ...args),
    );
    statements.push(
      db
        .prepare(`INSERT INTO analytics_daily(day,game,internal,dwell_ms)
      SELECT d.day,COALESCE(v.game,''),?,SUM(d.milliseconds) FROM analytics_dwell d JOIN analytics_pageviews v ON v.id=d.view_id WHERE v.started_at_ms<=? AND ${eligible("v")} GROUP BY 1,2,3
      ON CONFLICT(day,game,internal) DO UPDATE SET dwell_ms=dwell_ms+excluded.dwell_ms`)
        .bind(Number(include), cutoff, ...args),
    );
    statements.push(
      db
        .prepare(`WITH eligible AS (SELECT * FROM analytics_participants p WHERE ${eligible("p")})
      INSERT INTO analytics_daily(day,game,internal,started,completed,abandoned,cpu_matches,human_matches,duration_ms,participation_ms,singles,doubles,incomplete)
      SELECT ${day("m.started_at_ms")},m.game,?,COUNT(*),SUM(status='completed'),SUM(status='abandoned'),SUM(cpu_count>0),SUM(cpu_count=0),
      SUM(CASE WHEN status='completed' THEN ended_at_ms-started_at_ms ELSE 0 END),
      SUM((COALESCE(ended_at_ms,?)-started_at_ms)*(SELECT COUNT(*) FROM eligible p WHERE p.match_id=m.id)),SUM(mode='singles'),SUM(mode='doubles'),SUM(status='playing')
      FROM analytics_matches m WHERE started_at_ms<=? AND EXISTS(SELECT 1 FROM eligible p WHERE p.match_id=m.id) GROUP BY 1,2,3
      ON CONFLICT(day,game,internal) DO UPDATE SET started=started+excluded.started,completed=completed+excluded.completed,abandoned=abandoned+excluded.abandoned,cpu_matches=cpu_matches+excluded.cpu_matches,human_matches=human_matches+excluded.human_matches,duration_ms=duration_ms+excluded.duration_ms,participation_ms=participation_ms+excluded.participation_ms,singles=singles+excluded.singles,doubles=doubles+excluded.doubles,incomplete=incomplete+excluded.incomplete`)
        .bind(...args, Number(include), now, cutoff),
    );
  }
  statements.push(
    db.prepare("DELETE FROM analytics_disabled_participants WHERE expires_at_ms<=?").bind(now),
    db
      .prepare(
        "DELETE FROM analytics_dwell WHERE view_id IN (SELECT id FROM analytics_pageviews WHERE started_at_ms<=?)",
      )
      .bind(cutoff),
    db.prepare("DELETE FROM analytics_pageviews WHERE started_at_ms<=?").bind(cutoff),
    db
      .prepare(
        "DELETE FROM analytics_participants WHERE match_id IN (SELECT id FROM analytics_matches WHERE started_at_ms<=?)",
      )
      .bind(cutoff),
    db.prepare("DELETE FROM analytics_matches WHERE started_at_ms<=?").bind(cutoff),
  );
  await db.batch(statements);
}
