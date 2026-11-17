import type { RatedMatchmakingGame } from "@tetraboard/protocol";

export function ratingStatements(game: RatedMatchmakingGame) {
  const elo = game === "shogi" || game === "reversi";
  const pendingTable = elo ? "elo_rating_pending" : "skill_rating_pending";
  const changesTable = elo ? "elo_rating_changes" : "skill_rating_changes";
  const ratingColumns = elo ? "rating_after" : "mu_after AS rating_after, sigma_after";
  const clearPending = (db: D1Database, matchId: string) =>
    db.prepare(`DELETE FROM ${pendingTable} WHERE game='${game}' AND match_id=?`).bind(matchId);
  return {
    game,
    pendingTable,
    changesTable,
    latest: (db: D1Database, accountId: string) =>
      db
        .prepare(`SELECT ${ratingColumns}, rated_games, human_games FROM ${changesTable}
        WHERE game='${game}' AND account_id=? ORDER BY rated_games DESC LIMIT 1`)
        .bind(accountId),
    reserve: (db: D1Database, matchId: string, accountId: string, operationId: string) =>
      db
        .prepare(`INSERT INTO ${pendingTable}(game,account_id,match_id,room_id,instance_id)
        SELECT '${game}',account_id,?,room_id,instance_id FROM account_room_seats WHERE account_id=? AND operation_id=?
        ON CONFLICT(game,account_id) DO NOTHING`)
        .bind(matchId, accountId, operationId),
    clearPending,
    unappliedMatch: `NOT EXISTS (SELECT 1 FROM ${changesTable} WHERE game='${game}' AND match_id = ?1)`,
  };
}
