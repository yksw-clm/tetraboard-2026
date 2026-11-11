import { fourReversiRatedMatchmakingRules, ratedMatchmakingRules } from "@tetraboard/protocol";
import { fourReversiRatingBeta } from "../../../../packages/ai/fourReversiRating";
import type { FourReversiCpuRating } from "../rooms/fourReversiRating";
import { findNamedCpuProfile } from "./cpuProfiles";

export const fourReversiCalibrationVersion = "four-reversi-lv1-lv5-v1";
const references = [
  ["lv1-v1", "efa9502656a959bcfd993e7ba42ac0c705d4b20ee53fda63316e9538097271f0", 11.62695152723769],
  [
    "lv2-v1",
    "e9d73d9f70c9784667348f31b732ac396e1fba8422d37828698a61e311ee3305",
    22.450170489740945,
  ],
  ["lv3-v1", "c2b327ed2e4beebdaee84931b35cea50bf8cbaf54831e6e116219a5913cbc748", 25],
  ["lv5-v1", "c16ee482750b7ba37e554beaa776317dd4b00fe071a9c47f66f186adab575163", 29.13612058222954],
] as const;

export function calibratedFourReversiProfile(reference: FourReversiCpuRating) {
  const fixed = references.find(([id]) => id === reference.profileId);
  if (
    !fixed ||
    reference.profileHash !== fixed[1] ||
    reference.mu !== fixed[2] ||
    reference.sigma !== 1
  )
    return;
  const profile = findNamedCpuProfile(reference.profileId);
  if (
    profile?.hash === reference.profileHash &&
    profile.engineVersion === "0.2.0" &&
    profile.rulesetVersion === "four-reversi-singles-v2" &&
    profile.stateVersion === 2
  )
    return profile;
}

const profiles = references.map(([profileId, profileHash, mu]) => ({
  profileId,
  profileHash,
  mu,
  sigma: 1,
}));
const availableProfiles = () => profiles.filter(calibratedFourReversiProfile);
export const hasCalibratedFourReversiProfiles = () => availableProfiles().length > 0;

export type FourReversiRatingSource = {
  kind: "four-reversi";
  calibrationVersion: string;
  cpu?: FourReversiCpuRating;
};
const ratedMatch = {
  kind: "four-reversi",
  calibrationVersion: fourReversiCalibrationVersion,
} as const;
export type QueueRating = { rating?: number; sigma?: number; ratedGames?: number };
export const fourReversiWidenAfterMs = 10_000;

export function nearestRankedCpu<T extends { mu: number; profileId: string }>(
  players: QueueRating[],
  profiles: T[],
  placementGames: number,
) {
  const mus = players
    .flatMap(({ ratedGames, rating }) =>
      (ratedGames ?? 0) >= placementGames && rating !== undefined ? [rating] : [],
    )
    .sort((a, b) => a - b);
  const middle = Math.floor(mus.length / 2);
  const target = !mus.length
    ? 25
    : mus.length % 2
      ? mus[middle]!
      : (mus[middle - 1]! + mus[middle]!) / 2;
  return [...profiles].sort(
    (a, b) =>
      Math.abs(a.mu - target) - Math.abs(b.mu - target) ||
      a.mu - b.mu ||
      a.profileId.localeCompare(b.profileId),
  )[0];
}

export function selectFourReversi<T extends QueueRating>(
  eligible: T[],
  elapsed: number,
): { selected: T[]; rating: FourReversiRatingSource } | undefined {
  return selectFourPlayerRated(
    eligible,
    elapsed,
    fourReversiRatedMatchmakingRules,
    ratedMatch,
    (players) =>
      nearestRankedCpu(
        players,
        availableProfiles(),
        ratedMatchmakingRules["four-reversi"].placementGames,
      ),
  );
}

export function selectFourPlayerRated<T extends QueueRating, R extends object, C>(
  eligible: T[],
  elapsed: number,
  rules: { seats: number; fillAfterMs: number },
  ratedMatch: R,
  chooseCpu: (players: T[]) => C | undefined,
): { selected: T[]; rating: R & { cpu?: C } } | undefined {
  const candidates = eligible.slice(0, 16);
  const [oldest, ...others] = candidates;
  if (!oldest) return;
  const { seats, fillAfterMs } = rules;
  const expired = elapsed >= fillAfterMs;
  if (candidates.length < seats) {
    if (!expired) return;
    const cpu = chooseCpu(candidates);
    if (cpu) return { selected: candidates, rating: { ...ratedMatch, cpu } };
    return;
  }
  if (
    candidates.some(
      (w) =>
        w.rating === undefined ||
        (w.ratedGames ?? 0) < 10 ||
        (w.sigma ?? Infinity) > fourReversiRatingBeta,
    )
  )
    return { selected: candidates.slice(0, seats), rating: ratedMatch };

  const limit = expired
    ? Infinity
    : (elapsed >= fourReversiWidenAfterMs ? 2 : 1) * fourReversiRatingBeta;
  let best: T[] | undefined;
  let bestSpread = Infinity;
  for (const [i, first] of others.entries()) {
    for (const [j, second] of others.entries()) {
      if (j <= i) continue;
      for (const third of others.slice(j + 1)) {
        const group = [oldest, first, second, third];
        const mus = group.map(({ rating }) => rating!);
        const spread = Math.max(...mus) - Math.min(...mus);
        if (spread <= limit && spread < bestSpread) {
          best = group;
          bestSpread = spread;
        }
      }
    }
  }
  if (best) return { selected: best, rating: ratedMatch };
}
