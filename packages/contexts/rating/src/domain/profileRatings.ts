import type { RatingGame } from "./policy";
import { publicRatingForMu } from "./publicRating";

export function hasProfileRating(game: string): game is RatingGame {
  return game === "shogi" || game === "reversi" || game === "four-shogi" || game === "four-reversi";
}

export type CpuRatingReference = { rating: number } | { mu: number };

export function cpuProfileRating(reference?: CpuRatingReference) {
  if (!reference) return;
  return {
    timing: "reference" as const,
    status: "rated" as const,
    rating: "mu" in reference ? publicRatingForMu(reference.mu) : reference.rating,
  };
}
