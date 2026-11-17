import { rateFourReversi, initialFourReversiRating, fourReversiPlacementGames } from "./skill";
import { publicRatingBase, publicRatingScale, publicRatingForMu } from "./publicRating";
import type { SkillPlayer } from "./skillMatch";
export type CurrentSkill = {
  account_id: string;
  mu: number;
  sigma: number;
  rated_games: number;
  human_games: number;
};
export type SkillChange = {
  accountId: string;
  muBefore: number;
  sigmaBefore: number;
  muAfter: number;
  sigmaAfter: number;
  ratedGames: number;
  humanGames: number;
};
export function skillChanges(
  players: SkillPlayer[],
  ranks: number[],
  results: CurrentSkill[],
): SkillChange[] {
  const humans = players.filter((p) => p.kind === "human");
  const before = new Map(results.map((row) => [row.account_id, row]));
  const ratings = players.map((player) =>
    player.kind === "human" ? before.get(player.accountId!)! : player.reference,
  );
  const updated = rateFourReversi(ratings, ranks as number[]);
  const maxRatingChange = humans.length < 4 ? 24 : 32;
  return players.flatMap((player, index) => {
    if (player.kind !== "human") return [];
    const row = before.get(player.accountId!)!;
    const next = updated[index]!;
    let muAfter = next.mu;
    if (row.rated_games >= fourReversiPlacementGames) {
      const previousRating = publicRatingForMu(row.mu);
      const change = publicRatingForMu(muAfter) - previousRating;
      if (Math.abs(change) > maxRatingChange) {
        const cappedRating = previousRating + Math.sign(change) * maxRatingChange;
        muAfter =
          initialFourReversiRating.mu + (cappedRating - publicRatingBase) / publicRatingScale;
      }
    }
    return [
      {
        accountId: row.account_id,
        muBefore: row.mu,
        sigmaBefore: row.sigma,
        muAfter,
        sigmaAfter: next.sigma,
        ratedGames: row.rated_games + 1,
        humanGames: row.human_games + Number(humans.length > 1),
      },
    ];
  });
}
