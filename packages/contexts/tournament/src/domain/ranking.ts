import type { TournamentStanding } from "@tetraboard/protocol";
export function tournamentRankPointsUnits(
  pointsUnits: readonly number[],
  rank: number,
  tiedCount = 1,
): number {
  if (
    !Number.isInteger(rank) ||
    !Number.isInteger(tiedCount) ||
    rank < 1 ||
    tiedCount < 1 ||
    rank + tiedCount > 5
  )
    throw new RangeError("順位と同順位人数が正しくありません。");
  return (
    pointsUnits
      .slice(rank - 1, rank - 1 + tiedCount)
      .reduce<number>((sum, value) => sum + value, 0) / tiedCount
  );
}
export function compareTournamentScores(
  a: TournamentStanding,
  b: TournamentStanding,
  game: string = "four-shogi",
): number {
  return (
    Number(b.games > 0) - Number(a.games > 0) ||
    b.pointsUnits - a.pointsUnits ||
    (game === "four-shogi" ? b.knockouts - a.knockouts : 0) ||
    a.rankSum * b.games - b.rankSum * a.games
  );
}
export function rankTournamentStandings<T extends TournamentStanding>(
  values: T[],
  game: string = "four-shogi",
): T[] {
  const sorted = [...values].sort(
    (a, b) =>
      compareTournamentScores(a, b, game) || (a.username ?? "").localeCompare(b.username ?? ""),
  );
  let rank = 0;
  return sorted.map((row, index) => {
    if (row.games && (index === 0 || compareTournamentScores(sorted[index - 1]!, row, game) !== 0))
      rank = index + 1;
    return { ...row, rank: row.games ? rank : null };
  });
}
