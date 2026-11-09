import { join } from "node:path";
import {
  initialFourReversiRating,
  predictFourReversiPair,
  rateFourReversi,
} from "../fourReversiRating";

const colors = ["black", "white", "red", "blue"];
type Outcome = { color: string; rank: number; score: number | null };
type Matchup = { id: string; lineup: string[] };
type Unit = { ids: string[]; slots: number[]; outcomes: Outcome[]; matchup: string };

export async function readCalibrationUnit(
  path: string,
  seed: number,
  matchups: Matchup[],
  seats: number,
): Promise<Unit[]> {
  const lines = (await Bun.file(path).text())
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const summary = lines.pop();
  if (
    summary?.record_type !== "summary" ||
    summary.seed !== seed ||
    summary.completed_games !== matchups.length * seats ||
    summary.failed_games !== 0 ||
    lines.length !== matchups.length * seats
  )
    throw Error(`不完全な測定単位です: ${path}`);
  const seen = new Set<string>();
  return lines.map((line) => {
    const matchup = matchups.find(({ id }) => id === line.matchup_id);
    const slots: number[] = line.lineup_slots;
    const ids: string[] = line.profile_ids;
    const outcomes: Outcome[] = colors.map((color) =>
      line.game?.outcomes.find((o: Outcome) => o.color === color),
    );
    const identity = `${line.matchup_id}:${slots.join(",")}`;
    if (
      line.record_type !== "game" ||
      line.error ||
      !matchup ||
      slots.length !== 4 ||
      new Set(slots).size !== 4 ||
      ids.length !== 4 ||
      slots.some((slot, i) => ids[i] !== matchup.lineup[slot]) ||
      outcomes.some(
        (outcome) =>
          !outcome || !Number.isInteger(outcome.rank) || outcome.rank < 1 || outcome.rank > 4,
      ) ||
      seen.has(identity)
    )
      throw Error(`不正または重複した対局ログです: ${path}`);
    seen.add(identity);
    return { ids, slots, outcomes, matchup: matchup.id };
  });
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const percentiles = (values: number[], ps: number[]) => {
  values.sort((a, b) => a - b);
  return ps.map((p) => values[Math.ceil(values.length * p) - 1]!);
};
function interval(blocks: number[], samples: Uint8Array, ps: number[]) {
  const means = [];
  for (let offset = 0; offset < samples.length; offset += 32) {
    let sum = 0;
    for (let i = 0; i < 32; i++) sum += blocks[i]! * samples[offset + i]!;
    means.push(sum / 32);
  }
  return percentiles(means, ps);
}

async function resamples(study: string, seed: number, count: number) {
  const proc = Bun.spawn([study, "calibration-samples", String(seed), String(count)], {
    stdout: "pipe",
  });
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0 || bytes.length !== count * 32)
    throw Error("ChaCha8の再標本化に失敗しました");
  return bytes;
}

type PreparedGame = { indices: number[]; ranks: number[] };
function fit(blocks: PreparedGame[][], multiplicities: Uint8Array) {
  const ratings: { mu: number; sigma: number }[] = Array.from({ length: 20 }, () => ({
    ...initialFourReversiRating,
  }));
  for (const [seedIndex, games] of blocks.entries()) {
    for (let sample = 0; sample < multiplicities[seedIndex]!; sample++) {
      for (const { indices, ranks } of games) {
        const updated = rateFourReversi(
          indices.map((i) => ratings[i]!),
          ranks,
          true,
        );
        for (const [i, index] of indices.entries()) ratings[index] = updated[i]!;
      }
    }
  }
  const averages = Array.from({ length: 5 }, (_, i) =>
    mean(ratings.slice(i * 4, i * 4 + 4).map(({ mu }) => mu)),
  );
  const shift = 25 - averages[2]!;
  return {
    means: averages.map((mu) => mu + shift),
    byColor: ratings.map(({ mu, sigma }) => ({ mu: mu + shift, sigma })),
  };
}

function metrics() {
  return {
    games: 0,
    rankTotal: 0,
    ranks: [0, 0, 0, 0],
    wins: 0,
    soloWins: 0,
    sharedWins: 0,
    stones: 0,
  };
}

async function summarize(directory: string, study: string) {
  const manifest = (await Bun.file(join(directory, "manifest.json")).json()) as {
    version: string;
    identity: {
      profiles: { id: string; profile_hash: string }[];
      pairs: { id: string; matchups: Matchup[] }[];
      resampling: { intervalsSeed: number; referenceSeed: number };
    };
  };
  const { profiles, pairs, resampling } = manifest.identity;
  const profileIndex = new Map(profiles.map(({ id }, i) => [id, i]));
  async function readSeed(stage: string, seed: number) {
    const games = [];
    for (const pair of pairs) {
      const path = join(directory, `${stage}-${seed}-${pair.id}.jsonl`);
      games.push(...(await readCalibrationUnit(path, seed, pair.matchups, 24)));
    }
    return games;
  }
  const training = [];
  for (let seed = 3_000_000; seed < 3_000_032; seed++) {
    training.push(
      (await readSeed("calibration", seed)).map(({ ids, outcomes }) => ({
        indices: ids.map((id, i) => profileIndex.get(id)! * 4 + i),
        ranks: outcomes.map(({ rank }) => rank),
      })),
    );
  }
  const fitAll = fit(training, new Uint8Array(32).fill(1));
  const referenceSamples = await resamples(study, resampling.referenceSeed, 2000);
  const referenceMeans: number[][] = profiles.map(() => []);
  for (let i = 0; i < referenceSamples.length; i += 32) {
    const values = fit(training, referenceSamples.subarray(i, i + 32)).means;
    values.forEach((mu, j) => referenceMeans[j]!.push(mu));
  }
  const references = profiles.map(({ id, profile_hash }, i) => {
    const values = referenceMeans[i]!;
    const center = mean(values);
    const sigma = Math.max(1, Math.sqrt(mean(values.map((mu) => (mu - center) ** 2))));
    return {
      id,
      profileHash: profile_hash,
      mu: fitAll.means[i]!,
      sigma,
      byColor: Object.fromEntries(colors.map((color, j) => [color, fitAll.byColor[i * 4 + j]])),
    };
  });
  const predictions = references.map((a) => references.map((b) => predictFourReversiPair(a, b)));
  const intervalsSamples = await resamples(study, resampling.intervalsSeed, 100_000);
  const evaluations = [];
  const differences = new Map(
    pairs.flatMap(({ matchups }) => matchups.map(({ id }) => [id, [] as number[][]])),
  );
  const outcomesByGroup = new Map<string, ReturnType<typeof metrics>>();
  const errorsByGroup = new Map<string, { games: number; error: number; baseline: number }>();
  for (let seed = 4_000_000; seed < 4_000_032; seed++) {
    const games = await readSeed("evaluation", seed);
    const blocks = new Map<string, number[]>();
    let error = 0;
    let baseline = 0;
    for (const game of games) {
      const indices = game.ids.map((id) => profileIndex.get(id)!);
      const bySeat = game.outcomes.map(() => ({ error: 0, baseline: 0 }));
      for (let a = 0; a < 4; a++) {
        for (let b = a + 1; b < 4; b++) {
          const diff = game.outcomes[a]!.rank - game.outcomes[b]!.rank;
          const score = diff === 0 ? 0.5 : diff < 0 ? 1 : 0;
          const e = (predictions[indices[a]!]![indices[b]!]! - score) ** 2;
          const base = (0.5 - score) ** 2;
          error += e;
          baseline += base;
          for (const seat of [a, b]) {
            bySeat[seat]!.error += e / 3;
            bySeat[seat]!.baseline += base / 3;
          }
        }
      }
      game.outcomes.forEach(({ color, rank, score }, i) => {
        for (const key of [
          game.ids[i]!,
          `${game.ids[i]}:${color}`,
          `${game.matchup}:${game.slots[i]}`,
        ]) {
          const group = outcomesByGroup.get(key) ?? metrics();
          group.games++;
          group.rankTotal += rank;
          group.ranks[rank - 1]!++;
          if (rank === 1) {
            group.wins++;
            if (game.outcomes.filter((outcome) => outcome.rank === 1).length === 1)
              group.soloWins++;
            else group.sharedWins++;
          }
          group.stones += score ?? 0;
          outcomesByGroup.set(key, group);
          const errors = errorsByGroup.get(key) ?? { games: 0, error: 0, baseline: 0 };
          errors.games++;
          errors.error += bySeat[i]!.error;
          errors.baseline += bySeat[i]!.baseline;
          errorsByGroup.set(key, errors);
        }
      });
      const group = blocks.get(game.matchup) ?? [];
      group.push(
        game.outcomes[game.slots.indexOf(1)]!.rank - game.outcomes[game.slots.indexOf(0)]!.rank,
      );
      blocks.set(game.matchup, group);
    }
    for (const [key, block] of blocks) differences.get(key)!.push(block);
    evaluations.push({
      error: error / (games.length * 6),
      baseline: baseline / (games.length * 6),
    });
  }
  const comparisons = pairs.map(({ id, matchups }) => {
    const contexts = matchups.map(({ id: key }) => differences.get(key)!.map(mean));
    const blocks = contexts[0]!.map((_, i) => mean(contexts.map((values) => values[i]!)));
    const [low95, high95, low995, high995] = interval(
      blocks,
      intervalsSamples,
      [0.025, 0.975, 0.0025, 0.9975],
    ) as [number, number, number, number];
    const contextsMean = contexts.map(mean);
    let verdict = "保留";
    if (high95 - low95 <= 0.2) {
      if (low995 > 0.1 && contextsMean.every((x) => x > 0)) verdict = "Aが優位";
      else if (high995 < -0.1 && contextsMean.every((x) => x < 0)) verdict = "Bが優位";
      else if (low995 >= -0.1 && high995 <= 0.1) verdict = "同程度";
      else if (contextsMean.some((x) => x < 0) && contextsMean.some((x) => x > 0))
        verdict = "相性依存";
    }
    return {
      id,
      mean: mean(blocks),
      ci95: [low95, high95],
      ci995: [low995, high995],
      contextsMean,
      verdict,
    };
  });
  const improvements = evaluations.map(({ error, baseline }) => baseline - error);
  const improvementCi95 = interval(improvements, intervalsSamples, [0.025, 0.975]);
  return {
    version: manifest.version,
    calibrationGames: 23_040,
    evaluationGames: 23_040,
    references,
    prediction: {
      error: mean(evaluations.map(({ error }) => error)),
      baseline: mean(evaluations.map(({ baseline }) => baseline)),
      improvementCi95,
      passes: improvementCi95[0]! > 0,
    },
    comparisons,
    outcomesByGroup: Object.fromEntries(
      [...outcomesByGroup].map(([key, data]) => [
        key,
        {
          ...data,
          averageRank: data.rankTotal / data.games,
          averageStones: data.stones / data.games,
          winRate: data.wins / data.games,
          soloWinRate: data.soloWins / data.games,
          sharedWinRate: data.sharedWins / data.games,
        },
      ]),
    ),
    errorsByGroup: Object.fromEntries(
      [...errorsByGroup].map(([key, data]) => [
        key,
        {
          games: data.games,
          error: data.error / data.games,
          baseline: data.baseline / data.games,
        },
      ]),
    ),
  };
}

if (import.meta.main) {
  const [directory, study] = process.argv.slice(2);
  if (!directory || !study) throw Error("結果ディレクトリとstudyバイナリが必要です");
  console.log(JSON.stringify(await summarize(directory, study), null, 2));
}
