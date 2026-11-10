const version = "egaroucid-console-7.8.2-0c1b84ef";

const profiles = [
  { key: "mix25", referenceRating: 1297, level: 1, engineProbability: 0.25 },
  { key: "mix50", referenceRating: 1490, level: 1, engineProbability: 0.5 },
  { key: "mix75", referenceRating: 1748, level: 1, engineProbability: 0.75 },
  { key: "level1", referenceRating: 2109, level: 1, engineProbability: 1 },
  { key: "level2", referenceRating: 2385, level: 2, engineProbability: 1 },
  { key: "level4", referenceRating: 2650, level: 4, engineProbability: 1 },
  { key: "level8", referenceRating: 3003, level: 8, engineProbability: 1 },
].map(({ key, ...profile }) => ({ ...profile, profileId: `${version}-${key}-v1` }));

export function selectReversiCpu(rating: number) {
  const { profileId, referenceRating } = profiles.reduce((nearest, profile) =>
    Math.abs(profile.referenceRating - rating) < Math.abs(nearest.referenceRating - rating)
      ? profile
      : nearest,
  );
  return { kind: "cpu" as const, profileId, referenceRating };
}

export function reversiCpuProfile(source: { profileId: string; referenceRating: number }) {
  return profiles.find(
    (p) => p.profileId === source.profileId && p.referenceRating === source.referenceRating,
  );
}
