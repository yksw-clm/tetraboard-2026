import { matchmakingQueues, ratedCpuNames, ratedMatchmakingRules } from "@tetraboard/protocol";
import { nearestRankedCpu, selectFourPlayerRated, type QueueRating } from "./fourReversiSelection";

export const fourShogiEngineVersion = "four-shogi-lv3-v1";
export const fourShogiCalibrationVersion = "four-shogi-lv3-dev-v1";
const profiles = (
  [
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
  ] as const
).map((profile) => ({
  ...profile,
  name: ratedCpuNames.fourShogi[profile.work],
  sigma: 1,
  engineVersion: fourShogiEngineVersion,
}));

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

export function calibratedFourShogiProfile(
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

export function selectFourShogi<T extends QueueRating>(eligible: T[], elapsed: number) {
  return selectFourPlayerRated(
    eligible,
    elapsed,
    matchmakingQueues["four-shogi"],
    { kind: "four-shogi", calibrationVersion: fourShogiCalibrationVersion } as const,
    (players) => {
      const profile = nearestRankedCpu(
        players,
        profiles,
        ratedMatchmakingRules["four-shogi"].placementGames,
      );
      if (!profile) return;
      const { profileId, engineVersion, mu, sigma } = profile;
      return { profileId, engineVersion, mu, sigma };
    },
  );
}
