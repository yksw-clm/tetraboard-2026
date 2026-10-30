import type { RecordedGame, StrengthChoice, StrengthJob, StrengthOptions } from "./strength";
import { createStrengthJobs } from "./strength";

export const pilotStrategies = ["adaptive", "dual", "dual-continuations"] as const;
export type PilotStrategy = (typeof pilotStrategies)[number];

/** 同じ開始条件の3方式をまとめ、方式の先頭を3通りに循環させます。 */
export function createPilotSchedule(options: StrengthOptions): StrengthJob[] {
  const jobs = createStrengthJobs(options);
  const blocks = new Map<string, StrengthJob[]>();
  for (const job of jobs) {
    const key = `${job.seed}/${job.restricted}/${job.seat}`;
    const block = blocks.get(key) ?? [];
    block.push(job);
    blocks.set(key, block);
  }
  return [...blocks.values()].flatMap((block, index) =>
    pilotStrategies.map((_, offset) => {
      const strategy = pilotStrategies[(index + offset) % pilotStrategies.length];
      const found = block.filter((job) => job.searchStrategy === strategy);
      if (found.length !== 1 || block.length !== 3) throw new Error("3方式の開始条件が揃いません");
      return found[0];
    }),
  );
}

export function numericSummary(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (q: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : null;
  return {
    count: sorted.length,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    p50: quantile(0.5),
    p95: quantile(0.95),
    max: sorted.at(-1) ?? null,
  };
}
export type PilotObservation = { game: RecordedGame; choices: readonly StrengthChoice[] };
function summarize(rows: readonly PilotObservation[]) {
  const finished = rows.filter(({ game }) => game.sample.status === "finished");
  const allChoices = rows.flatMap((row) => row.choices);
  const searches = allChoices.filter((choice) => choice.reason !== "forced_legal_action");
  const dual = searches.filter((choice) => choice.search?.coverage !== undefined);
  const soleFirst = finished.filter(({ game }) => game.sample.soleFirst).length;
  const rate = (n: number, d: number) => (d ? n / d : null);
  const earlyEliminations = rows.filter(({ game }) =>
    game.sample.eliminations.some((entry) => entry.side === game.sample.seat),
  );
  return {
    attempted: rows.length,
    finished: finished.length,
    unfinished: rows.length - finished.length,
    soleFirst,
    soleFirstRateAmongFinished: rate(soleFirst, finished.length),
    // 未完了局を負けと数えた分母へ置換しません。参考の完了局条件付き比率とは区別します。
    soleFirstRateAll: finished.length === rows.length ? rate(soleFirst, rows.length) : null,
    meanRank: finished.length
      ? finished.reduce((sum, { game }) => sum + game.sample.rank!, 0) / finished.length
      : null,
    tiedFirst: finished.filter(({ game }) => game.sample.tiedFirst).length,
    repetitions: finished.filter(({ game }) => game.sample.termination === "repetition").length,
    repetitionRateAmongFinished: rate(
      finished.filter(({ game }) => game.sample.termination === "repetition").length,
      finished.length,
    ),
    earlyEliminations: earlyEliminations.length,
    earlyEliminationRate: rate(earlyEliminations.length, rows.length),
    completionRate: rate(finished.length, rows.length),
    eliminations: earlyEliminations.map(({ game }) => ({
      jobId: game.jobId,
      seed: game.sample.seed,
      seat: game.sample.seat,
      rank: game.sample.rank,
      elimination: game.sample.eliminations.find((entry) => entry.side === game.sample.seat),
    })),
    plies: numericSummary(rows.map(({ game }) => game.sample.moves)),
    candidateChoices: allChoices.length,
    forcedChoices: allChoices.length - searches.length,
    elapsedMs: numericSummary(allChoices.map((choice) => choice.elapsedMs)),
    searchElapsedMs: numericSummary(searches.map((choice) => choice.elapsedMs)),
    depth: numericSummary(searches.map((choice) => choice.depth)),
    depthOneRate: rate(searches.filter((choice) => choice.depth >= 1).length, searches.length),
    depthTwoRate: rate(searches.filter((choice) => choice.depth >= 2).length, searches.length),
    deepApplicableSearches: dual.length,
    deepReachRate: rate(
      dual.filter((choice) => choice.search?.timing?.deepStartedMs != null).length,
      dual.length,
    ),
    deadlineRate: rate(
      searches.filter((choice) => choice.reason === "deadline").length,
      searches.length,
    ),
    terminationReasons: Object.fromEntries(
      [...new Set(rows.map(({ game }) => game.sample.termination))].map((reason) => [
        reason,
        rows.filter(({ game }) => game.sample.termination === reason).length,
      ]),
    ),
    searchReasons: Object.fromEntries(
      [...new Set(searches.map((choice) => choice.reason))].map((reason) => [
        reason,
        searches.filter((choice) => choice.reason === reason).length,
      ]),
    ),
  };
}

export function summarizePilot(planned: readonly StrengthJob[], rows: readonly PilotObservation[]) {
  if (new Set(planned.map((job) => job.id)).size !== planned.length)
    throw new Error("計画に重複局があります");
  const seen = new Set<string>();
  for (const { game } of rows) {
    if (seen.has(game.jobId)) throw new Error("対局結果が重複しています");
    seen.add(game.jobId);
    const job = planned.find((value) => value.id === game.jobId);
    if (
      !job ||
      game.sample.matchId !== game.jobId ||
      job.seed !== game.sample.seed ||
      job.seat !== game.sample.seat ||
      job.restricted !== game.restricted ||
      job.searchStrategy !== game.searchStrategy
    )
      throw new Error("計画外の対局結果です");
  }
  const seeds = [...new Set(planned.map((job) => job.seed))];
  const completeSeeds = seeds.filter((seed) => {
    const expected = planned.filter((job) => job.seed === seed);
    return (
      expected.length === 24 &&
      expected.every((job) =>
        rows.some(({ game }) => game.jobId === job.id && game.sample.status === "finished"),
      )
    );
  });
  const complete = rows.filter(({ game }) => completeSeeds.includes(game.sample.seed));
  const cell = (game: RecordedGame) => `${game.sample.seed}/${game.restricted}/${game.sample.seat}`;
  const matchedCells = [...new Set(rows.map(({ game }) => cell(game)))].filter((key) =>
    pilotStrategies.every((strategy) =>
      rows.some(
        ({ game }) =>
          cell(game) === key &&
          game.searchStrategy === strategy &&
          game.sample.status === "finished",
      ),
    ),
  );
  const matched = rows.filter(({ game }) => matchedCells.includes(cell(game)));
  const byStrategy = (subset: readonly PilotObservation[]) =>
    Object.fromEntries(
      pilotStrategies.map((strategy) => [
        strategy,
        summarize(subset.filter(({ game }) => game.searchStrategy === strategy)),
      ]),
    );
  const grouped = (key: (game: RecordedGame) => string) =>
    Object.fromEntries(
      [...new Set(rows.map(({ game }) => key(game)))].map((value) => [
        value,
        byStrategy(rows.filter(({ game }) => key(game) === value)),
      ]),
    );
  return {
    independentSeedsPlanned: seeds.length,
    completeSeeds,
    completeMatchedSeedCount: completeSeeds.length,
    primary: byStrategy(complete),
    allAttemptsDescriptive: byStrategy(rows),
    partialMatchedCellsReference: { cells: matchedCells, ...byStrategy(matched) },
    byRule: grouped((game) => (game.restricted ? "on" : "off")),
    bySeat: grouped((game) => game.sample.seat),
    bySeed: grouped((game) => String(game.sample.seed)),
    pairedBySeed: seeds.map((seed) => ({
      seed,
      complete: completeSeeds.includes(seed),
      strategies: byStrategy(rows.filter(({ game }) => game.sample.seed === seed)),
    })),
    interval: null,
    inference:
      "1系列の席替え・ON/OFFは相関標本です。信頼区間・有意差・正式棋力を認定しません。未完了局は勝敗へ変換しません。",
    unstartedJobIds: planned.filter((job) => !seen.has(job.id)).map((job) => job.id),
  };
}
