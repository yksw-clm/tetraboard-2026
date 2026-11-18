import type { BadgeId, GameId } from "@tetraboard/protocol";

export type BadgeGame = "four-reversi" | "four-shogi";
export interface BadgeCatalog {
  ids(game: GameId): readonly BadgeId[];
  thresholds(id: BadgeId): readonly number[];
}
export type BadgeThreshold = { id: BadgeId; tier: number; threshold: number };

export function badgeThresholds(catalog: BadgeCatalog, game: BadgeGame): BadgeThreshold[] {
  return catalog
    .ids(game)
    .flatMap((id) =>
      catalog.thresholds(id).map((threshold, index) => ({ id, tier: index + 1, threshold })),
    );
}

export function isBadgeGame(game: string): game is BadgeGame {
  return game === "four-reversi" || game === "four-shogi";
}
