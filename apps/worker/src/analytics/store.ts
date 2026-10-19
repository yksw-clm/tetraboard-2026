import { analyticsRetentionMs } from "@tetraboard/protocol/privacy";
import { analyticsSessionIdleMs } from "@tetraboard/protocol";
export type AnalyticsIdentity = {
  visitorId: string | null;
  accountId: string | null;
  isTest: boolean;
  isGuest?: boolean;
};
export type AnalyticsMatch = {
  id: string;
  game: string;
  mode: string;
  startedAtMs: number;
  endedAtMs: number | null;
  status: "playing" | "completed" | "abandoned";
  cpuCount: number;
  participants: (AnalyticsIdentity & { playerId: string })[];
};
export type AnalyticsJob = { record: AnalyticsMatch; revision: number; retryAtMs: number };
export const analyticsPendingPrefix = "analytics-pending:";
export const analyticsActiveKey = "analytics-active";
export const analyticsPlayerKey = (id: string) => `analytics-player:${id}`;
export const visitorCookie = "tetraboard-2026.analytics";
export function analyticsVisitor(request: Request): string | null {
  const value = request.headers
    .get("Cookie")
    ?.split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${visitorCookie}=`))
    ?.slice(visitorCookie.length + 1);
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}
export function coverageStatement(db: D1Database, at: number) {
  return db
    .prepare(
      "INSERT INTO analytics_metadata (key, value) VALUES ('collected_from', ?) ON CONFLICT(key) DO UPDATE SET value = MIN(value, excluded.value)",
    )
    .bind(at);
}
export async function writeAnalyticsMatch(db: D1Database, record: AnalyticsMatch) {
  if (record.startedAtMs <= Date.now() - analyticsRetentionMs) return;
  await db.batch([
    coverageStatement(db, record.startedAtMs),
    db
      .prepare(`INSERT INTO analytics_matches (id, game, mode, started_at_ms, ended_at_ms, status, cpu_count)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      status = CASE WHEN analytics_matches.status = 'playing' THEN excluded.status ELSE analytics_matches.status END,
      ended_at_ms = COALESCE(analytics_matches.ended_at_ms, excluded.ended_at_ms)`)
      .bind(
        record.id,
        record.game,
        record.mode,
        record.startedAtMs,
        record.endedAtMs,
        record.status,
        record.cpuCount,
      ),
    ...record.participants.map((p) =>
      db
        .prepare(`INSERT INTO analytics_participants (match_id, player_id, account_id, visitor_id, is_test,
          session_id,referrer_class,utm_source,utm_medium,utm_campaign,device,is_guest)
      SELECT ?, ?, COALESCE((SELECT account_id FROM guest_account_merges WHERE guest_id=?),?), ?, ?,s.id,s.referrer_class,s.utm_source,s.utm_medium,s.utm_campaign,s.device,?
      FROM (SELECT 1) LEFT JOIN analytics_sessions s ON s.id=(SELECT id FROM analytics_sessions
        WHERE visitor_id=? AND started_at_ms<=? AND last_activity_ms>? AND started_at_ms>?
        ORDER BY started_at_ms DESC,id LIMIT 1)
      WHERE NOT EXISTS (SELECT 1 FROM deleted_accounts WHERE id=?) AND EXISTS (SELECT 1 FROM analytics_matches WHERE id=?) ON CONFLICT(match_id, player_id) DO NOTHING`)
        .bind(
          record.id,
          p.playerId,
          p.accountId,
          p.accountId,
          p.visitorId,
          Number(p.isTest),
          Number(Boolean(p.isGuest)),
          p.visitorId,
          record.startedAtMs,
          record.startedAtMs - analyticsSessionIdleMs,
          Date.now() - analyticsRetentionMs,
          p.accountId,
          record.id,
        ),
    ),
  ]);
}
