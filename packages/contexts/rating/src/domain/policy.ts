export type EloGame = "shogi" | "reversi";
export type SkillGame = "four-shogi" | "four-reversi";
export type RatingGame = EloGame | SkillGame;
export type TimeControl = { mainTimeMs: number; byoyomiMs: number };
export const placementGames = 5;
export const eloInitialRating = 1500;
export const eloPolicy = {
  initialRating: eloInitialRating,
  placementGames,
  human: { placement: 64, rated: 32 },
  cpu: { placement: 48, rated: 16 },
  scale: 400,
} as const;
export const isEloGame = (game: RatingGame): game is EloGame =>
  game === "shogi" || game === "reversi";

// 成立済みの対局は、時計設定が変わった後の再送でも反映します。
export function ratedTimeControls(game: RatingGame): TimeControl[] {
  if (game === "shogi")
    return [
      { mainTimeMs: 600_000, byoyomiMs: 0 },
      { mainTimeMs: 300_000, byoyomiMs: 30_000 },
    ];
  if (game === "reversi")
    return [
      { mainTimeMs: 300_000, byoyomiMs: 0 },
      { mainTimeMs: 180_000, byoyomiMs: 0 },
    ];
  return [
    { mainTimeMs: 0, byoyomiMs: 30_000 },
    { mainTimeMs: 180_000, byoyomiMs: 0 },
  ];
}
export function isRatedTimeControl(game: RatingGame, clock?: TimeControl) {
  return ratedTimeControls(game).some(
    (time) => clock?.mainTimeMs === time.mainTimeMs && clock.byoyomiMs === time.byoyomiMs,
  );
}
