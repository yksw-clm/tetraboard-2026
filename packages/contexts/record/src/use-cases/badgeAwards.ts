import {
  badgeThresholds,
  isBadgeGame,
  type BadgeCatalog,
  type BadgeGame,
  type BadgeThreshold,
} from "../domain/badges";

export interface BadgePublication<Write> {
  awards(game: BadgeGame, matchId: string, thresholds: BadgeThreshold[]): Write;
  notification(matchId: string, now: number): Write;
}

// 棋譜・本人索引と同じ batch に追加できるよう、書き込みを返します。
export function prepareBadgeAwards<Write>(
  publication: BadgePublication<Write>,
  catalog: BadgeCatalog,
  game: string,
  matchId: string,
  now: () => number,
): Write[] {
  if (!isBadgeGame(game)) return [];
  return [
    publication.awards(game, matchId, badgeThresholds(catalog, game)),
    publication.notification(matchId, now()),
  ];
}
