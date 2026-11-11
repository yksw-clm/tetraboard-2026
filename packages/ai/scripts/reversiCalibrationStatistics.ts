export const profiles = [
  "local2",
  "mix25",
  "mix50",
  "mix75",
  "level1",
  "level2",
  "level4",
  "level8",
] as const;
export type Profile = (typeof profiles)[number];
export type Score = 0 | 0.5 | 1;

export const pairs = profiles.flatMap((a, i) => profiles.slice(i + 1).map((b) => ({ a, b })));

export function random(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

type PairScores = readonly [Score, Score];
export type OpeningScores = readonly PairScores[];

export function fitElo(blocks: readonly OpeningScores[]) {
  const comparisons = pairs.map(({ a, b }, index) => ({
    a,
    b,
    // 完勝した組でも推定値が発散しないよう、両側に半勝ずつ加えます。
    points: blocks.reduce((total, block) => total + block[index]![0] + block[index]![1], 0.5),
  }));
  const scores = Object.fromEntries(profiles.map((profile) => [profile, 0])) as Record<
    Profile,
    number
  >;
  const games = blocks.length * 2 + 1;
  for (let iteration = 0; iteration < 1000; iteration++) {
    let maxChange = 0;
    for (const profile of profiles.slice(1)) {
      let gradient = 0;
      let information = 0;
      for (const { a, b, points } of comparisons) {
        if (a !== profile && b !== profile) continue;
        const expectation = 1 / (1 + Math.exp(scores[b] - scores[a]));
        gradient += (a === profile ? 1 : -1) * (points - games * expectation);
        information += games * expectation * (1 - expectation);
      }
      const change = Math.max(-2, Math.min(2, gradient / information));
      scores[profile] += change;
      maxChange = Math.max(maxChange, Math.abs(change));
    }
    if (maxChange < 1e-8)
      return Object.fromEntries(
        profiles.map((profile) => [profile, 1500 + scores[profile] * (400 / Math.LN10)]),
      ) as Record<Profile, number>;
  }
  throw Error("Eloの推定が収束しません");
}

function interval(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  return [at(0.025), at(0.975)] as const;
}

function resample<T>(blocks: readonly T[], next: () => number) {
  return blocks.map(() => blocks[Math.floor(next() * blocks.length)]!);
}

function mean(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarize(
  calibration: readonly OpeningScores[],
  evaluation: readonly OpeningScores[],
  samples: number,
) {
  if (!calibration.length || !evaluation.length || !Number.isInteger(samples) || samples < 1)
    throw Error("較正・評価・再標本化には1件以上が必要です");
  const elo = fitElo(calibration);
  const calibrationRandom = random(9_500_010);
  const evaluationRandom = random(9_500_011);
  const eloSamples = Array.from({ length: samples }, () =>
    fitElo(resample(calibration, calibrationRandom)),
  );
  const probability = pairs.map(({ a, b }) => 1 / (1 + 10 ** ((elo[b] - elo[a]) / 400)));
  const errors = evaluation.map((block) => {
    const values = block.flatMap((scores, index) =>
      scores.map((score) => ({
        predicted: (score - probability[index]!) ** 2,
        baseline: (score - 0.5) ** 2,
      })),
    );
    const predicted = mean(values.map((x) => x.predicted));
    const baseline = mean(values.map((x) => x.baseline));
    return { predicted, baseline, improvement: baseline - predicted };
  });
  const improvement = errors.map((block) => block.improvement);
  const pairScores = pairs.map((pair, index) => {
    const blocks = evaluation.map((block) => mean(block[index]!));
    return {
      ...pair,
      expectedScoreA: probability[index],
      observedScoreA: mean(blocks),
      observedScoreA95: interval(
        Array.from({ length: samples }, () => mean(resample(blocks, evaluationRandom))),
      ),
    };
  });
  return {
    ratings: profiles.map((profile) => ({
      profile,
      elo: elo[profile],
      elo95: interval(eloSamples.map((sample) => sample[profile])),
    })),
    evaluation: {
      predictedMse: mean(errors.map((x) => x.predicted)),
      baselineMse: mean(errors.map((x) => x.baseline)),
      improvement: mean(improvement),
      improvement95: interval(
        Array.from({ length: samples }, () => mean(resample(improvement, evaluationRandom))),
      ),
      pairs: pairScores,
    },
  };
}
