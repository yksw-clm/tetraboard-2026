import { badgeDefinitions, getBadgeIds } from "@tetraboard/protocol";
import {
  badgeThresholds,
  prepareBadgeAwards,
  type BadgeCatalog,
  type BadgeGame,
  type BadgeThreshold,
} from "@tetraboard/context-record";
import { accountNotDeletedSql } from "../../db/deletionGuard";
import { matchOutcomesCte } from "./matchOutcomes";

const badgeCatalog: BadgeCatalog = {
  ids: getBadgeIds,
  thresholds: (id) => badgeDefinitions[id].thresholds,
};

/** 保存済み戦績の集計条件を共用し、閾値の正本から SQL を組み立てます。 */
export function badgeAwardsSql(game: BadgeGame, baseline = false, personal = false): string {
  return awardSql(game, badgeThresholds(badgeCatalog, game), baseline, personal);
}

function awardSql(game: BadgeGame, rows: BadgeThreshold[], baseline = false, personal = false) {
  const gameLiteral = `'${game}'`;
  const thresholds = rows.map(({ id, tier, threshold }) => `('${id}', ${tier}, ${threshold})`);
  return `${matchOutcomesCte(game, personal, !baseline)}, totals AS (
    SELECT account_id, COUNT(*) AS games, SUM(rank = 1) AS wins,
      SUM(knockouts) AS knockouts,
      SUM(CASE WHEN rank = 1 AND knockouts = 3
        AND json_extract(result, '$.reason') = 'last_player'
        AND (SELECT COUNT(*) FROM json_each(result, '$.standings') s
          WHERE json_extract(s.value, '$.rank') = 1) = 1 THEN 1 ELSE 0 END) AS perfect_wins
    FROM outcomes WHERE mode = 'singles' GROUP BY account_id
    ${baseline ? "" : "HAVING SUM(match_id = ?) > 0"}
  ), thresholds(badge_id, tier, threshold) AS (VALUES ${thresholds.join(", ")}), values_by_badge AS (
    SELECT account_id, badge_id, tier, threshold,
      CASE badge_id WHEN 'games' THEN games WHEN 'wins' THEN wins
        WHEN 'knockouts' THEN knockouts ELSE perfect_wins END AS value
    FROM totals CROSS JOIN thresholds
  )
  INSERT INTO account_badge_awards (account_id, game, badge_id, tier, value, previous_tier, match_id)
  SELECT account_id, ${gameLiteral}, badge_id, tier, value,
    COALESCE((SELECT MAX(a.tier) FROM account_badge_awards a
      WHERE a.account_id = v.account_id AND a.game = ${gameLiteral} AND a.badge_id = v.badge_id), 0),
    ${baseline ? "NULL" : "?"}
  FROM values_by_badge v WHERE value >= threshold AND ${accountNotDeletedSql("v.account_id")}
  ON CONFLICT(account_id, game, badge_id, tier) DO NOTHING`;
}

export function badgeAwardStatements(db: D1Database, game: string, matchId: string) {
  return prepareBadgeAwards(
    {
      awards: (game, matchId, thresholds) =>
        db.prepare(awardSql(game, thresholds)).bind(game, matchId, matchId, matchId),
      notification: (matchId, now) =>
        db
          .prepare(`INSERT INTO account_badge_notifications (account_id, match_id, game, created_at_ms)
      SELECT DISTINCT account_id, match_id, game, ? FROM account_badge_awards
      WHERE match_id = ? AND ${accountNotDeletedSql("account_badge_awards.account_id")}
      ON CONFLICT(account_id, match_id) DO NOTHING`)
          .bind(now, matchId),
    },
    badgeCatalog,
    game,
    matchId,
    Date.now,
  );
}
