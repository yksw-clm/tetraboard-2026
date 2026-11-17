import {
  initialFourReversiRating,
  type SkillRatingStore,
  type SkillGame,
  type CurrentSkill,
  type SkillChange,
} from "@tetraboard/context-rating";
import { ratingStatements } from "./tables";
export class D1SkillRatingStore implements SkillRatingStore<D1PreparedStatement> {
  constructor(private db: D1Database) {}
  async applied(game: SkillGame, matchId: string) {
    const { changesTable } = ratingStatements(game);
    return !!(await this.db
      .prepare(`SELECT 1 FROM ${changesTable} WHERE game='${game}' AND match_id=?`)
      .bind(matchId)
      .first());
  }
  async current(game: SkillGame, ids: string[]) {
    const { changesTable } = ratingStatements(game);
    const { results } = await this.db
      .prepare(`
      SELECT u.id AS account_id, COALESCE(r.mu_after, ?2) AS mu, COALESCE(r.sigma_after, ?3) AS sigma,
        COALESCE(r.rated_games, 0) AS rated_games, COALESCE(r.human_games, 0) AS human_games
      FROM json_each(?1) ids JOIN user u ON u.id=ids.value
      LEFT JOIN ${changesTable} r ON r.game='${game}' AND r.account_id=u.id AND r.rated_games=(
        SELECT MAX(rated_games) FROM ${changesTable} WHERE game='${game}' AND account_id=u.id
      )
      WHERE COALESCE(u.isAnonymous, 0)=0 AND NOT EXISTS (SELECT 1 FROM deleted_accounts WHERE id=u.id)
    `)
      .bind(JSON.stringify(ids), initialFourReversiRating.mu, initialFourReversiRating.sigma)
      .all<CurrentSkill>();
    return results;
  }
  changes(game: SkillGame, matchId: string, changes: SkillChange[]) {
    const { changesTable } = ratingStatements(game);
    return this.db
      .prepare(`
      WITH changes AS MATERIALIZED (SELECT value AS row FROM json_each(?2))
      INSERT INTO ${changesTable}
        (game, match_id, account_id, mu_before, sigma_before, mu_after, sigma_after, rated_games, human_games)
      SELECT '${game}', ?1, row->>'$.accountId', row->>'$.muBefore', row->>'$.sigmaBefore',
        row->>'$.muAfter', row->>'$.sigmaAfter', row->>'$.ratedGames', row->>'$.humanGames'
      FROM changes
      WHERE NOT EXISTS (SELECT 1 FROM ${changesTable} WHERE game='${game}' AND match_id=?1)
        AND NOT EXISTS (
          SELECT 1 FROM changes c WHERE c.row->>'$.ratedGames' - 1 <> COALESCE((
            SELECT MAX(r.rated_games) FROM ${changesTable} r WHERE r.game='${game}' AND r.account_id=c.row->>'$.accountId'
          ), 0) OR NOT EXISTS (
            SELECT 1 FROM user u WHERE u.id=c.row->>'$.accountId' AND COALESCE(u.isAnonymous, 0)=0
              AND NOT EXISTS (SELECT 1 FROM deleted_accounts WHERE id=u.id)
          )
        )
    `)
      .bind(matchId, JSON.stringify(changes));
  }
  async save(write: D1PreparedStatement) {
    return (await write.run()).meta.changes;
  }
}
