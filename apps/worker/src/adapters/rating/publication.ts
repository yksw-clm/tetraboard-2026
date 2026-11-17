import type {
  RatingPublication,
  RatingGame,
  EloGame,
  eloPolicy,
  TimeControl,
} from "@tetraboard/context-rating";
import { ratingStatements } from "./tables";
import { eloChanges } from "./eloPublication";
export class D1RatingPublication implements RatingPublication<D1PreparedStatement> {
  constructor(private db: D1Database) {}
  eloChanges(game: EloGame, matchId: string, policy: typeof eloPolicy, clocks: TimeControl[]) {
    return eloChanges(this.db, game, matchId, policy, clocks);
  }
  reserve(game: RatingGame, matchId: string, accountId: string, operationId: string) {
    return ratingStatements(game).reserve(this.db, matchId, accountId, operationId);
  }
  clearPending(game: RatingGame, matchId: string) {
    return ratingStatements(game).clearPending(this.db, matchId);
  }
  clearPublishedPending(game: RatingGame, matchId: string) {
    return this.db
      .prepare(`DELETE FROM ${ratingStatements(game).pendingTable} WHERE game='${game}' AND match_id = ?1
        AND EXISTS (SELECT 1 FROM matches WHERE id = ?1 AND game = ?2)`)
      .bind(matchId, game);
  }
  latest(game: RatingGame, accountId: string) {
    return ratingStatements(game).latest(this.db, accountId);
  }
}
