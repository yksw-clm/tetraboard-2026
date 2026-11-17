import { nearestRankedCpu, selectFourPlayerRated, type QueueRating } from "./fourReversiSelection";
export const fourShogiEngineVersion = "four-shogi-lv3-v1";
export const fourShogiCalibrationVersion = "four-shogi-lv3-dev-v1";
export type FourShogiCpuReference = {
  profileId: string;
  engineVersion: string;
  mu: number;
  sigma: number;
};
export type FourShogiRatingSource = {
  kind: "four-shogi";
  calibrationVersion: string;
  cpu?: FourShogiCpuReference;
};
const references = [
  {
    profileId: "four-shogi-lv3-work4096-v1",
    work: 4096,
    mu: 23.74057892918443,
  },
  { profileId: "four-shogi-lv3-work16384-v1", work: 16384, mu: 25 },
  {
    profileId: "four-shogi-lv3-work65536-v1",
    work: 65536,
    mu: 25.980724801061935,
  },
] as const;
export function createFourShogiSelection({
  rules,
  placementGames,
  beta,
  names,
}: {
  rules: { seats: number; fillAfterMs: number };
  placementGames: number;
  beta: number;
  names: Record<4096 | 16384 | 65536, string>;
}) {
  const profiles = references.map((profile) => ({
    ...profile,
    name: names[profile.work],
    sigma: 1,
    engineVersion: fourShogiEngineVersion,
  }));

  function calibratedFourShogiProfile(
    reference: FourShogiCpuReference,
  ): (FourShogiCpuReference & { work: number; name: string }) | undefined {
    return profiles.find(
      (profile) =>
        reference.profileId === profile.profileId &&
        reference.engineVersion === profile.engineVersion &&
        reference.mu === profile.mu &&
        reference.sigma === profile.sigma,
    );
  }

  function selectFourShogi<T extends QueueRating>(eligible: T[], elapsed: number) {
    return selectFourPlayerRated(
      eligible,
      elapsed,
      rules,
      { kind: "four-shogi", calibrationVersion: fourShogiCalibrationVersion } as const,
      (players) => {
        const profile = nearestRankedCpu(players, profiles, placementGames);
        if (!profile) return;
        const { profileId, engineVersion, mu, sigma } = profile;
        return { profileId, engineVersion, mu, sigma };
      },
      beta,
    );
  }
  return { calibratedFourShogiProfile, selectFourShogi };
}
