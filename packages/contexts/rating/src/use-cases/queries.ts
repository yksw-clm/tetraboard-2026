import { isEloGame, placementGames, type RatingGame } from "../domain/policy";
import { publicRating, rankRatings, isPlacement } from "../domain/publicRating";
import type { RatingReader } from "./ports";
export const readLatestRating = (store: RatingReader, game: RatingGame, accountId: string) =>
  store.latest(game, accountId);
export async function readRatingSummary(store: RatingReader, game: RatingGame, accountId: string) {
  const row = await readLatestRating(store, game, accountId);
  if (!row || isPlacement(row.rated_games))
    return { status: "placement" as const, games: row?.rated_games ?? 0 };
  return {
    status: "rated" as const,
    rating: publicRating(game, row.rating_after),
    ...(!isEloGame(game) ? { humanPlayed: row.human_games > 0 } : {}),
  };
}
export async function readPublicRating(store: RatingReader, game: RatingGame, accountId: string) {
  const row = await readLatestRating(store, game, accountId);
  if (row && !isPlacement(row.rated_games))
    return { rating: publicRating(game, row.rating_after), humanPlayed: row.human_games > 0 };
}
export async function readProfileRating(
  store: RatingReader,
  game: RatingGame,
  accountId: string,
  timing: "current" | "before",
) {
  const row = await readLatestRating(store, game, accountId);
  if (!row || isPlacement(row.rated_games)) return { timing, status: "placement" as const };
  return {
    timing,
    status: "rated" as const,
    ...(timing === "current" ? { humanPlayed: row.human_games > 0 } : {}),
    rating: publicRating(game, row.rating_after),
  };
}
export async function readBeforeRating(
  store: Pick<RatingReader, "before">,
  game: RatingGame,
  matchId: string,
  accountId: string,
) {
  const row = await store.before(game, matchId, accountId);
  if (!row) return { timing: "before" as const, status: "unavailable" as const };
  if (row.rated_games <= placementGames)
    return { timing: "before" as const, status: "placement" as const };
  return {
    timing: "before" as const,
    status: "rated" as const,
    rating: publicRating(game, row.rating),
  };
}
export async function readRatingRankings(store: RatingReader, game: RatingGame) {
  return rankRatings(await store.rankings(game));
}
export function readPendingRating(
  store: RatingReader,
  accountId: string,
  game: RatingGame,
  games: RatingGame[],
) {
  return store.previous(
    accountId,
    [...games].sort((a, b) => Number(b === game) - Number(a === game)),
  );
}

export async function readPendingRatingAccounts(store: RatingReader, accountIds: string[]) {
  return new Set(await store.pendingAccounts(accountIds));
}
