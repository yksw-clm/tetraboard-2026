import { badgeDefinitions, getBadgeIds } from "@tetraboard/protocol";
import { matchOutcomesCte } from "./matchOutcomes";

type BadgeGame = "four-reversi" | "four-shogi";

/** 保存済み戦績の集計条件を共用し、閾値の正本からSQLを組み立てます。 */
export function badgeAwardsSql(game: BadgeGame, baseline = false, personal = false): string {
  const thresholds = getBadgeIds(game).flatMap((id) =>
    badgeDefinitions[id].thresholds.map((value, index) => `('${id}', ${index + 1}, ${value})`),
  );
  return `${matchOutcomesCte(game, personal, !baseline)}, totals AS (
    SELECT account_id, COUNT(*) AS games, SUM(rank = 1) AS wins,
      SUM(knockouts) AS knockouts,
      SUM(CASE WHEN rank = 1 AND knockouts = 3
        AND json_extract(result, '$.reason') = 'last_player'
        AND (SELECT COUNT(*) FROM json_each(result, '$.standings') s
          WHERE json_extract(s.value, '$.rank') = 1) = 1 THEN 1 ELSE 0 END) AS perfect_wins
    FROM outcomes WHERE mode = 'singles' GROUP BY account_id
  ), thresholds(badge_id, tier, threshold) AS (VALUES ${thresholds.join(", ")}), values_by_badge AS (
    SELECT account_id, badge_id, tier, threshold,
      CASE badge_id WHEN 'games' THEN games WHEN 'wins' THEN wins
        WHEN 'knockouts' THEN knockouts ELSE perfect_wins END AS value
    FROM totals CROSS JOIN thresholds
  )
  INSERT INTO account_badge_awards (account_id, game, badge_id, tier, value, previous_tier, match_id)
  SELECT account_id, '${game}', badge_id, tier, value,
    COALESCE((SELECT MAX(a.tier) FROM account_badge_awards a
      WHERE a.account_id = v.account_id AND a.game = '${game}' AND a.badge_id = v.badge_id), 0),
    ${baseline ? "NULL" : "?"}
  FROM values_by_badge v WHERE value >= threshold
  ON CONFLICT(account_id, game, badge_id, tier) DO NOTHING`;
}

/** 本体・本人索引と同じbatchへ追加し、取得イベントも一緒に確定します。 */
export function badgeAwardStatements(db: D1Database, game: string, matchId: string) {
  if (game !== "four-reversi" && game !== "four-shogi") return [];
  return [
    db.prepare(badgeAwardsSql(game)).bind(game, matchId, matchId),
    db
      .prepare(`INSERT INTO account_badge_notifications (account_id, match_id, game, created_at_ms)
      SELECT DISTINCT account_id, match_id, game, ? FROM account_badge_awards WHERE match_id = ?
      ON CONFLICT(account_id, match_id) DO NOTHING`)
      .bind(Date.now(), matchId),
  ];
}
