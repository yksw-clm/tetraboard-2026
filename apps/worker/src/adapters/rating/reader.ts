import {
  placementGames,
  isEloGame,
  publicRatingBase,
  publicRatingScale,
  initialFourReversiRating,
  type RatingReader,
  type RatingGame,
  type EloGame,
  type SkillGame,
  type EloResultRow,
  type SkillResultRow,
  type LatestRating,
  type RankingRow,
  type PendingRating,
} from "@tetraboard/context-rating";
import { ratedMatchmakingGameIds } from "@tetraboard/protocol";
import { ratingStatements } from "./tables";
const skillStorage = {
  "four-reversi": { key: "fourReversiRating", seat: "color" },
  "four-shogi": { key: "fourShogiRating", seat: "side" },
};
export class D1RatingReader implements RatingReader {
  constructor(private db: D1Database) {}
  latest(game: RatingGame, accountId: string) {
    return ratingStatements(game).latest(this.db, accountId).first<LatestRating>();
  }
  before(game: RatingGame, matchId: string, accountId: string) {
    const ranked = !isEloGame(game);
    const changesTable = ratingStatements(game).changesTable;
    return this.db
      .prepare(`SELECT ${ranked ? "mu_before" : "rating_before"} AS rating, rated_games
      FROM ${changesTable} WHERE game='${game}' AND match_id=? AND account_id=?`)
      .bind(matchId, accountId)
      .first<{ rating: number; rated_games: number }>();
  }
  async eloResult(game: EloGame, accountId: string, matchId: string, includeOpponent: boolean) {
    const { changesTable, pendingTable } = ratingStatements(game);
    return this.db
      .prepare(`
    SELECT 'saved' AS phase, json_extract(m.record_json, '$.rating.usedFallback') AS fallback,
      r.rating_before, r.rating_after, r.rated_games, r.human_games,
      CASE WHEN ?3 = 1 THEN json_extract(m.record_json, '$.rating.referenceRating') END AS cpu_rating,
      o.rating_before AS opponent_before, o.rating_after AS opponent_after,
      o.rated_games AS opponent_games
    FROM account_match_history h JOIN matches m ON m.id = h.match_id
    LEFT JOIN ${changesTable} r ON r.game = '${game}' AND r.account_id = h.account_id AND r.match_id = m.id
    LEFT JOIN ${changesTable} o ON o.game = '${game}' AND ?3 = 1 AND o.match_id = m.id AND o.account_id <> h.account_id
    WHERE h.account_id = ?1 AND m.id = ?2 AND m.game = '${game}'
      AND json_extract(m.record_json, '$.rating.kind') IS NOT NULL
    UNION ALL
    SELECT 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    FROM ${pendingTable} WHERE game = '${game}' AND account_id = ?1 AND match_id = ?2
  `)
      .bind(accountId, matchId, Number(includeOpponent))
      .first<EloResultRow>();
  }
  async skillResult(game: SkillGame, accountId: string, matchId: string) {
    const { changesTable, pendingTable } = ratingStatements(game);
    const { key, seat } = skillStorage[game];
    const { results } = await this.db
      .prepare(`
    SELECT json_extract(p.value, '$.id') AS player_id,
      json_extract(p.value, '$.accountId') = ?1 AS own,
      json_extract(m.record_json, '$.${key}.usedFallback') AS fallback,
      json_extract(m.record_json, '$.${key}.cpu.' || json_extract(p.value, '$.${seat}') || '.mu') AS cpu_mu,
      r.mu_before, r.mu_after, r.rated_games, r.human_games,
      EXISTS(SELECT 1 FROM ${pendingTable} WHERE game='${game}' AND account_id=?1 AND match_id=?2) AS pending
    FROM account_match_history h JOIN matches m ON m.id=h.match_id
    JOIN json_each(m.record_json, '$.participants') p
    LEFT JOIN ${changesTable} r
      ON r.game='${game}' AND r.match_id=m.id AND r.account_id=json_extract(p.value, '$.accountId')
    WHERE h.account_id=?1 AND m.id=?2 AND m.game='${game}'
      AND json_extract(m.record_json, '$.${key}.method') IS NOT NULL
    UNION ALL
    SELECT NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, 1
    FROM ${pendingTable} WHERE game='${game}' AND account_id=?1 AND match_id=?2
  `)
      .bind(accountId, matchId)
      .all<SkillResultRow>();
    return results;
  }
  async rankings(game: RatingGame) {
    const { changesTable } = ratingStatements(game);
    const rawRating = isEloGame(game)
      ? "r.rating_after"
      : `${publicRatingBase} + ${publicRatingScale} * (r.mu_after - ${initialFourReversiRating.mu})`;
    // SQLite の丸めを Math.round と一致させます。
    const rows = await this.db
      .prepare(`WITH latest AS (
    SELECT account_id, MAX(rated_games) AS games FROM ${changesTable} WHERE game='${game}' GROUP BY account_id
  ), public_values AS (
    SELECT u.id AS accountId, u.publicProfileId AS profileId, u.username, u.name,
      u.avatarKey, u.avatarPresetId, CAST(floor((${rawRating}) + 0.5) AS INTEGER) AS value
    FROM latest l JOIN ${changesTable} r ON r.game='${game}' AND r.account_id=l.account_id AND r.rated_games=l.games
    JOIN user u ON u.id=r.account_id
    WHERE l.games>=?1 AND u.profileCompleted=1 AND COALESCE(u.isAnonymous,0)=0
      AND NOT EXISTS(SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
      AND NOT EXISTS(SELECT 1 FROM guest_account_merges g WHERE g.guest_id=u.id)
  ), ranked AS (
    SELECT *, RANK() OVER(ORDER BY value DESC) AS rank,
      ROW_NUMBER() OVER(ORDER BY value DESC, username ASC) AS position FROM public_values
  ) SELECT * FROM ranked WHERE position<=10 ORDER BY position`)
      .bind(placementGames)
      .all<RankingRow>();
    return rows.results;
  }
  async pendingAccounts(accountIds: string[]) {
    const rows = await this.db
      .prepare(
        ratedMatchmakingGameIds
          .map(
            (game) =>
              `SELECT account_id FROM ${ratingStatements(game).pendingTable} WHERE account_id IN (SELECT value FROM json_each(?1))`,
          )
          .join(" UNION ALL "),
      )
      .bind(JSON.stringify(accountIds))
      .all<{ account_id: string }>();
    return rows.results.map((row) => row.account_id);
  }
  previous(accountId: string, games: RatingGame[]) {
    return this.db
      .prepare(
        games
          .map(
            (game) =>
              `SELECT '${game}' AS game, match_id, room_id, instance_id FROM ${ratingStatements(game).pendingTable} AS pending WHERE game='${game}' AND account_id=?1`,
          )
          .join(" UNION ALL ") + " LIMIT 1",
      )
      .bind(accountId)
      .first<PendingRating>();
  }
}
