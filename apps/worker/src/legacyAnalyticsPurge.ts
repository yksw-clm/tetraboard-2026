// 分析テーブルを消す PR で、このファイルごと消す。
import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";

export async function purgeLegacyAnalytics(env: Pick<Env, "APP_DB">, now = Date.now()) {
  const db = env.APP_DB;
  const cutoff = now - analyticsRetentionMs;
  const cutoffDay = new Date(cutoff + 32400000).toISOString().slice(0, 10);
  await db.batch([
    db.prepare("DELETE FROM analytics_matchmaking_events WHERE at_ms<=?").bind(cutoff),
    db.prepare("DELETE FROM analytics_registration_flows WHERE created_at_ms<=?").bind(cutoff),
    db.prepare("DELETE FROM analytics_registration_attempts WHERE expires_at_ms<=?").bind(now),
    db.prepare("DELETE FROM analytics_registration_deleted_flows WHERE expires_at_ms<=?").bind(now),
    db.prepare("DELETE FROM analytics_sessions WHERE started_at_ms<=?").bind(cutoff),
    db
      .prepare("DELETE FROM analytics_acquisition_snapshot WHERE dimension='host' AND day<=?")
      .bind(cutoffDay),
    db.prepare("DELETE FROM account_game_daily WHERE day<=?").bind(cutoffDay),
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
  ]);
}
