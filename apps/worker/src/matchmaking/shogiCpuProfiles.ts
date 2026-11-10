import type { ShogiRatingSource } from "../rooms/shogiRating";

const profiles = [
  { nodes: 128, referenceRating: 1365 },
  { nodes: 64, referenceRating: 1403 },
  { nodes: 256, referenceRating: 1488 },
  { nodes: 512, referenceRating: 1552 },
  { nodes: 1024, referenceRating: 1778 },
].map(({ nodes, referenceRating }) => ({
  kind: "cpu" as const,
  profileId: `yaneuraou-material-faeb37f0-n${nodes}-standard-book-v1`,
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

export function shogiCpuProfile(profileId: string) {
  const active = profiles.find((profile) => profile.profileId === profileId);
  if (active) return { nodes: active.nodes, standardBook: true };
  // 変更前に割り当てられた対局は保存済みの基準レートと探索条件で完了します。
  const legacy = profiles.find(
    ({ nodes }) => profileId === `yaneuraou-material-faeb37f0-n${nodes}-v1`,
  );
  return legacy && { nodes: legacy.nodes, standardBook: false };
}
