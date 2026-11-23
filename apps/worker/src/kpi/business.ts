import type { KpiQuery } from "@tetraboard/protocol";
import { replayWithin7Days } from "./calculations";
import { dayMs, kpiPeriod, kpiWeeks, weekMs } from "./period";
import type { KpiEnv } from "./query";

async function readWeeklyActivePlayers(db: D1Database, periodEndMs: number, nowMs: number) {
  const { fromMs, toMs, weeks } = kpiWeeks(periodEndMs, nowMs);
  const { results } = await db
    .prepare(`SELECT CAST((m.ended_at_ms - ?1) / ?2 AS INTEGER) AS weekIndex,
      COUNT(DISTINCT h.account_id) AS players,
      COUNT(DISTINCT CASE WHEN u.isAnonymous IS NOT 1 THEN h.account_id END) AS linked
    FROM account_match_history h JOIN matches m ON m.id=h.match_id JOIN user u ON u.id=h.account_id
    WHERE m.ended_at_ms >= ?1 AND m.ended_at_ms < ?3 AND COALESCE(u.isTestUser,0)=0
      AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=h.account_id)
    GROUP BY weekIndex`)
    .bind(fromMs, weekMs, toMs)
    .all<{ weekIndex: number; players: number; linked: number }>();
  const counts = new Map(results.map((row) => [row.weekIndex, row]));
  return weeks.map((week, index) => ({
    ...week,
    players: counts.get(index)?.players ?? 0,
    linked: counts.get(index)?.linked ?? 0,
  }));
}

export async function readBusinessKpi(env: KpiEnv, query: KpiQuery, nowMs: number) {
  const { fromMs, toMs } = kpiPeriod(query);
  const db = env.APP_DB;
  const completedMatches = await db
    .prepare(`SELECT COUNT(*) AS count FROM matches m
    WHERE m.ended_at_ms >= ? AND m.ended_at_ms < ?
    AND NOT (EXISTS (SELECT 1 FROM account_match_history h WHERE h.match_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM account_match_history h LEFT JOIN user u ON u.id=h.account_id
        WHERE h.match_id=m.id AND COALESCE(u.isTestUser,0)=0))`)
    .bind(fromMs, toMs)
    .first<number>("count");
  const players = await db
    .prepare(`SELECT COUNT(DISTINCT h.account_id) AS count
    FROM account_match_history h JOIN matches m ON m.id=h.match_id JOIN user u ON u.id=h.account_id
    WHERE m.ended_at_ms >= ? AND m.ended_at_ms < ? AND COALESCE(u.isTestUser,0)=0
      AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=h.account_id)`)
    .bind(fromMs, toMs)
    .first<number>("count");
  const participation = await db
    .prepare(`WITH first_completion AS (
      SELECT h.account_id, MIN(m.ended_at_ms) AS first_at FROM account_match_history h
      JOIN matches m ON m.id=h.match_id JOIN user u ON u.id=h.account_id
      WHERE COALESCE(u.isTestUser,0)=0 AND m.ended_at_ms <= ?
        AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=h.account_id)
      GROUP BY h.account_id HAVING MIN(m.ended_at_ms) >= ? AND MIN(m.ended_at_ms) < ?)
    SELECT h.account_id AS accountId, m.id AS matchId, m.ended_at_ms AS endedAtMs
    FROM first_completion f JOIN account_match_history h ON h.account_id=f.account_id
    JOIN matches m ON m.id=h.match_id WHERE m.ended_at_ms >= f.first_at
      AND m.ended_at_ms < ? AND m.ended_at_ms <= ?`)
    .bind(nowMs, fromMs, toMs, toMs + 7 * dayMs, nowMs)
    .all<{ accountId: string; matchId: string; endedAtMs: number }>();
  const weeklyActivePlayers = await readWeeklyActivePlayers(db, toMs, nowMs);
  return {
    completedMatches: completedMatches ?? 0,
    players: players ?? 0,
    weeklyActivePlayers,
    replayWithin7Days: replayWithin7Days(participation.results, { fromMs, toMs }, nowMs),
  };
}
