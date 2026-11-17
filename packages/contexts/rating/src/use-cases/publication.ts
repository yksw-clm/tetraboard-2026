import { eloPolicy, ratedTimeControls, type EloGame, type RatingGame } from "../domain/policy";
import type { RatingPublication } from "./ports";
export function prepareEloRating<Write>(
  store: RatingPublication<Write>,
  game: EloGame,
  matchId: string,
) {
  return [
    store.eloChanges(game, matchId, eloPolicy, ratedTimeControls(game)),
    store.clearPublishedPending(game, matchId),
  ];
}
export function reserveRating<Write>(
  store: RatingPublication<Write>,
  game: RatingGame,
  matchId: string,
  accountId: string,
  operationId: string,
) {
  return store.reserve(game, matchId, accountId, operationId);
}
export function cancelRating<Write>(
  store: RatingPublication<Write>,
  game: RatingGame,
  matchId: string,
) {
  return store.clearPending(game, matchId);
}
export function prepareLatestRating<Write>(
  store: RatingPublication<Write>,
  game: RatingGame,
  accountId: string,
) {
  return store.latest(game, accountId);
}
