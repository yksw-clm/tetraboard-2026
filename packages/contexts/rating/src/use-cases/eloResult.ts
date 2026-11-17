import { isPlacement } from "../domain/publicRating";
import { placementGames, type EloGame } from "../domain/policy";
import type { RatingReader } from "./ports";
export type RatingOpponent =
  | { status: "cpu"; rating: number }
  | { status: "placement" }
  | { status: "rated"; rating: number; previousRating: number };
export async function readEloRatingResult(
  store: RatingReader,
  game: EloGame,
  accountId: string,
  matchId: string,
  includeOpponent: boolean,
) {
  const row = await store.eloResult(game, accountId, matchId, includeOpponent);
  if (!row) return null;
  if (row.phase === "pending") return { status: "pending" };
  if (row.rated_games === null)
    return {
      status: "excluded",
      reason: row.fallback ? "ai_fallback" : "unavailable",
    };
  let opponent: RatingOpponent | undefined;
  if (row.cpu_rating !== null) {
    opponent = { status: "cpu", rating: row.cpu_rating };
  } else if (
    row.opponent_games !== null &&
    row.opponent_after !== null &&
    row.opponent_before !== null
  ) {
    opponent = isPlacement(row.opponent_games)
      ? { status: "placement" }
      : { status: "rated", rating: row.opponent_after, previousRating: row.opponent_before };
  }
  if (isPlacement(row.rated_games))
    return { status: "placement", games: row.rated_games, opponent };
  return {
    status: "rated",
    rating: row.rating_after,
    previousRating: row.rating_before,
    humanPlayed: (row.human_games ?? 0) > 0,
    placementCompleted: row.rated_games === placementGames,
    opponent,
  };
}
