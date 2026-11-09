import type { ShogiRatingSource } from "../rooms/shogiRating";

const profiles = [
  { nodes: 64, referenceRating: 1304 },
  { nodes: 128, referenceRating: 1352 },
  { nodes: 256, referenceRating: 1500 },
  { nodes: 512, referenceRating: 1613 },
  { nodes: 1024, referenceRating: 1764 },
].map(({ nodes, referenceRating }) => ({
  kind: "cpu" as const,
  profileId: `yaneuraou-material-faeb37f0-n${nodes}-v1`,
  referenceRating,
  nodes,
}));

export function selectShogiCpu(rating: number): ShogiRatingSource {
  const { nodes: _nodes, ...source } = profiles.reduce((nearest, profile) =>
    Math.abs(profile.referenceRating - rating) < Math.abs(nearest.referenceRating - rating)
      ? profile
      : nearest,
  );
  return source;
}

export function shogiCpuNodes(profileId: string): number | undefined {
  return profiles.find((profile) => profile.profileId === profileId)?.nodes;
}
