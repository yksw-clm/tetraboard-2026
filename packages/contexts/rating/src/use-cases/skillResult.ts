import { fourReversiPlacementGames } from "../domain/skill";
import { publicRatingForMu, isPlacement } from "../domain/publicRating";
import type { SkillGame } from "../domain/policy";
import type { RatingReader, SkillResultRow } from "./ports";
import type { RatingOpponent } from "./eloResult";
export async function readSkillRatingResult(
  store: RatingReader,
  game: SkillGame,
  accountId: string,
  matchId: string,
  includeOpponents: boolean,
) {
  const results = await store.skillResult(game, accountId, matchId);
  if (results.some((row) => row.pending)) return { status: "pending" };
  const own = results.find((row) => row.own);
  if (!own) return null;
  if (own.mu_after === null || own.mu_before === null || own.rated_games === null)
    return {
      status: "excluded",
      reason: own.fallback ? "ai_fallback" : "unavailable",
    };
  const players = includeOpponents ? skillOpponents(results) : {};
  if (isPlacement(own.rated_games))
    return {
      status: "placement",
      games: own.rated_games,
      players,
    };
  return {
    status: "rated",
    rating: publicRatingForMu(own.mu_after),
    previousRating: publicRatingForMu(own.mu_before),
    humanPlayed: (own.human_games ?? 0) > 0,
    placementCompleted: own.rated_games === fourReversiPlacementGames,
    players,
  };
}
function skillOpponents(results: SkillResultRow[]) {
  const players: Record<string, RatingOpponent> = {};
  for (const row of results) {
    if (!row.player_id || row.own) continue;
    if (row.cpu_mu !== null)
      players[row.player_id] = {
        status: "cpu",
        rating: publicRatingForMu(row.cpu_mu),
      };
    else if (row.rated_games !== null && row.mu_after !== null && row.mu_before !== null)
      players[row.player_id] = isPlacement(row.rated_games)
        ? { status: "placement" }
        : {
            status: "rated",
            rating: publicRatingForMu(row.mu_after),
            previousRating: publicRatingForMu(row.mu_before),
          };
  }

  return players;
}
