import type { RatedMatchmakingGame } from "@tetraboard/protocol";

// テーブル名はゲームごとの保存実装が指定します。
export function createRatingStore(
  game: RatedMatchmakingGame,
  pendingTable: string,
  changesTable: string,
  ratingColumns = "rating_after",
) {
  const clearPending = (db: D1Database, matchId: string) =>
    db.prepare(`DELETE FROM ${pendingTable} WHERE match_id=?`).bind(matchId);
  return {
    pendingTable,
    changesTable,
    latest: (db: D1Database, accountId: string) =>
      db
        .prepare(`SELECT ${ratingColumns}, rated_games, human_games FROM ${changesTable}
        WHERE account_id=? ORDER BY rated_games DESC LIMIT 1`)
        .bind(accountId),
    reserve: (db: D1Database, matchId: string, accountId: string, operationId: string) =>
      db
        .prepare(`INSERT INTO ${pendingTable}(account_id,match_id,room_id,instance_id)
        SELECT account_id,?,room_id,instance_id FROM account_room_seats WHERE account_id=? AND operation_id=?
        ON CONFLICT(account_id) DO NOTHING`)
        .bind(matchId, accountId, operationId),
    clearPending,
    unappliedMatch: `NOT EXISTS (SELECT 1 FROM ${changesTable} WHERE match_id = ?1)`,
    finalize: (db: D1Database, matchId: string, update: D1PreparedStatement) => [
      update,
      db
        .prepare(`DELETE FROM ${pendingTable} WHERE match_id = ?1
        AND EXISTS (SELECT 1 FROM matches WHERE id = ?1 AND game = ?2)`)
        .bind(matchId, game),
    ],
  };
}
