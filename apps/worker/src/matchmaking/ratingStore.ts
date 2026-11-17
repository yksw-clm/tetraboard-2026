import {
  reserveRating,
  cancelRating,
  prepareLatestRating,
  type RatingGame,
} from "@tetraboard/context-rating";
import { D1RatingPublication } from "../adapters/rating/publication";
import { ratingStatements } from "../adapters/rating/tables";
export function createRatingStore(game: RatingGame) {
  const tables = ratingStatements(game);
  return {
    game,
    pendingTable: tables.pendingTable,
    changesTable: tables.changesTable,
    latest: (db: D1Database, accountId: string) =>
      prepareLatestRating(new D1RatingPublication(db), game, accountId),
    reserve: (db: D1Database, matchId: string, accountId: string, operationId: string) =>
      reserveRating(new D1RatingPublication(db), game, matchId, accountId, operationId),
    clearPending: (db: D1Database, matchId: string) =>
      cancelRating(new D1RatingPublication(db), game, matchId),
  };
}
