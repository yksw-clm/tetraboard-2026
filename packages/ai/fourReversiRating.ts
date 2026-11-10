import { predictWin, rate, type Rating } from "openskill";

export const fourReversiRatingMethod = "openskill-5.0.1-plackett-luce";
export const fourReversiPlacementGames = 5;
export const initialFourReversiRating = { mu: 25, sigma: 25 / 3 } as const;
export const fourReversiRatingBeta = 25 / 6;

export function rateFourReversi(ratings: Rating[], ranks: number[], calibration = false) {
  if (ratings.length !== 4 || ranks.length !== 4)
    throw Error("四人リバーシのレート計算には4席が必要です");
  const sorted = [...ranks].sort((a, b) => a - b);
  if (sorted.some((rank, i) => rank !== i + 1 && (i === 0 || rank !== sorted[i - 1])))
    throw Error("確定順位が競技順位方式と一致しません");
  return rate(
    ratings.map((rating) => [rating]),
    {
      rank: ranks,
      beta: fourReversiRatingBeta,
      tau: calibration ? 0 : 25 / 300,
    },
  ).map(([rating]) => rating!);
}

export function predictFourReversiPair(first: Rating, second: Rating) {
  return predictWin([[first], [second]], { beta: fourReversiRatingBeta })[0]!;
}
