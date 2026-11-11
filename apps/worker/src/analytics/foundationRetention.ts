import { gameScopeIds } from "@tetraboard/protocol";
import { adminAccountIds, type AdminEnv } from "../admin/auth";

/** 期限削除と同じトランザクションで、加算可能な値だけを匿名化します。 */
export function foundationArchiveStatements(env: Env, cutoff: number) {
  const db = env.APP_DB;
  const owners = adminAccountIds(env as AdminEnv) ?? [];
  const day = (column: string) => `strftime('%Y-%m-%d',${column}/1000+32400,'unixepoch')`;
  const scopes = `(SELECT value AS game FROM json_each('${JSON.stringify(gameScopeIds)}'))`;
  ("(SELECT 'all' AS game UNION ALL SELECT 'four-reversi' UNION ALL SELECT 'four-shogi' UNION ALL SELECT 'reversi' UNION ALL SELECT 'shogi' UNION ALL SELECT 'gomoku' UNION ALL SELECT 'four-gomoku')");
  const statements: D1PreparedStatement[] = [];
  for (const include of [false, true]) {
    const eligible = (alias: string) =>
      include
        ? "1"
        : `${alias}.is_test=0 ${owners.length ? `AND (${alias}.account_id IS NULL OR ${alias}.account_id NOT IN (${owners.map(() => "?").join(",")}))` : ""}`;
    const args = include ? [] : owners;
    const collected = "(SELECT collected_from_ms FROM analytics_foundation_state WHERE id=1)";
    statements.push(
      db
        .prepare(`INSERT INTO analytics_foundation_archive(day,game,internal,page_views)
      SELECT ${day("v.started_at_ms")},s.game,?,COUNT(*) FROM analytics_pageviews v
      JOIN ${scopes} s ON s.game='all' OR s.game=v.game
      WHERE v.started_at_ms<=? AND v.started_at_ms>=${collected} AND ${eligible("v")} GROUP BY 1,2,3
      ON CONFLICT(day,game,internal) DO UPDATE SET page_views=page_views+excluded.page_views`)
        .bind(Number(include), cutoff, ...args),
    );
    statements.push(
      db
        .prepare(`INSERT INTO analytics_foundation_archive(day,game,internal,dwell_ms)
      SELECT d.day,s.game,?,SUM(d.milliseconds) FROM analytics_dwell d JOIN analytics_pageviews v ON v.id=d.view_id
      JOIN ${scopes} s ON s.game='all' OR s.game=v.game
      WHERE v.started_at_ms<=? AND v.started_at_ms>=${collected} AND ${eligible("v")} GROUP BY 1,2,3
      ON CONFLICT(day,game,internal) DO UPDATE SET dwell_ms=dwell_ms+excluded.dwell_ms`)
        .bind(Number(include), cutoff, ...args),
    );
    statements.push(
      db
        .prepare(`INSERT INTO analytics_foundation_archive(day,game,internal,started,completed,abandoned,cpu_matches,human_matches,completed_duration_ms,incomplete)
      SELECT ${day("m.started_at_ms")},s.game,?,COUNT(*),SUM(m.status='completed'),SUM(m.status='abandoned'),SUM(m.cpu_count>0),SUM(m.cpu_count=0),
        SUM(CASE WHEN m.status='completed' THEN m.ended_at_ms-m.started_at_ms ELSE 0 END),SUM(m.status='playing')
      FROM analytics_matches m JOIN ${scopes} s ON s.game='all' OR s.game=m.game
      WHERE m.started_at_ms<=? AND m.started_at_ms>=${collected}
        AND EXISTS(SELECT 1 FROM analytics_participants p WHERE p.match_id=m.id AND ${eligible("p")}) GROUP BY 1,2,3
      ON CONFLICT(day,game,internal) DO UPDATE SET started=started+excluded.started,completed=completed+excluded.completed,
        abandoned=abandoned+excluded.abandoned,cpu_matches=cpu_matches+excluded.cpu_matches,human_matches=human_matches+excluded.human_matches,
        completed_duration_ms=completed_duration_ms+excluded.completed_duration_ms,incomplete=incomplete+excluded.incomplete`)
        .bind(Number(include), cutoff, ...args),
    );
  }
  return statements;
}
