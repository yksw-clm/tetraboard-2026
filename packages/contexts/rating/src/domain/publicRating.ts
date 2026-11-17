import { initialFourReversiRating } from "./skill";
import { isEloGame, placementGames, type RatingGame } from "./policy";
export const publicRatingBase = 1500;
export const publicRatingScale = 50;
export function publicRatingForMu(mu: number) {
  return Math.round(publicRatingBase + publicRatingScale * (mu - initialFourReversiRating.mu));
}
export function publicRating(game: RatingGame, value: number) {
  return isEloGame(game) ? value : publicRatingForMu(value);
}
export function isPlacement(games: number) {
  return games < placementGames;
}

export function rankRatings<T extends { value: number; username: string }>(rows: T[]) {
  let rank = 0;
  return [...rows]
    .sort(
      (a, b) =>
        b.value - a.value || (a.username < b.username ? -1 : a.username > b.username ? 1 : 0),
    )
    .slice(0, 10)
    .map((row, index, sorted) => {
      if (index === 0 || row.value !== sorted[index - 1]!.value) rank = index + 1;
      return { ...row, rank };
    });
}
