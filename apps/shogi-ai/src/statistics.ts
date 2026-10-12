import type { Side } from "@tetraboard/four-shogi";
export type Sample = {
  seed: number;
  seat: Side;
  rank: number | null;
  reward: number;
  draw: boolean;
  unfinished: boolean;
  plies: number;
};
export function metrics(samples: Sample[]) {
  const n = samples.length,
    wins = samples.filter((s) => !s.draw && !s.unfinished && s.rank === 1).length;
  const ranks = samples.filter((s) => s.rank !== null);
  const p = n ? wins / n : null;
  const z = 1.96,
    denom = 1 + (z * z) / Math.max(n, 1),
    centre = ((p ?? 0) + (z * z) / (2 * Math.max(n, 1))) / denom;
  const radius =
    (z *
      Math.sqrt(
        ((p ?? 0) * (1 - (p ?? 0))) / Math.max(n, 1) + (z * z) / (4 * Math.max(n, 1) ** 2),
      )) /
    denom;
  return {
    games: n,
    wins,
    draws: samples.filter((s) => s.draw).length,
    unfinished: samples.filter((s) => s.unfinished).length,
    averageRank: ranks.length ? ranks.reduce((sum, s) => sum + s.rank!, 0) / ranks.length : null,
    winRate: p,
    winInterval: n
      ? ([Math.max(0, centre - radius), Math.min(1, centre + radius)] as [number, number])
      : null,
    reward: n ? samples.reduce((sum, s) => sum + s.reward, 0) / n : null,
  };
}
/** 同じ開始系列の4席を一つの標本とし、席を独立試行として水増ししません。 */
export function pairedInterval(candidate: Sample[], parent: Sample[]): [number, number] | null {
  const bySeed = new Map<number, number[]>();
  for (const sample of candidate) {
    const match = parent.find((s) => s.seed === sample.seed && s.seat === sample.seat);
    if (!match) return null;
    const values = bySeed.get(sample.seed) ?? [];
    values.push(sample.reward - match.reward);
    bySeed.set(sample.seed, values);
  }
  const values = [...bySeed.values()]
    .filter((v) => v.length === 4)
    .map((v) => v.reduce((a, b) => a + b, 0) / 4);
  if (values.length !== bySeed.size || values.length < 8) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  // 8系列ではt(7)を使い、小標本での安易な採用を避けます。
  const radius = 2.365 * Math.sqrt(variance / values.length);
  return [mean - radius, mean + radius];
}
