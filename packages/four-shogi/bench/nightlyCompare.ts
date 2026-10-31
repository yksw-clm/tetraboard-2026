import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { experimentStarts } from "./searchExperiment";
import { loadPlayer } from "./baseline";
import {
  atomicJson,
  readJson,
  immutableJson,
  checkedJson,
  readCheckedJson,
  type GenerationManifest,
} from "./nightlyStore";
import { dataHash, sameData, outcomeFor, type GameArtifact } from "./selfPlayData";
import {
  restoreAnalysisPosition,
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  type AnalysisReplayInput,
} from "../src/analysis";
import { encodeAction } from "../src/actionEncoding";
import { sides, getActiveSides, type Side } from "../src/types";
import { runNativeStudy } from "./nightlyStudy";
import type { StudyPositionInput } from "../../../apps/four-shogi-study/src/shared/model";
import { nightlySource } from "./nightlyConfig";

export type ComparisonPlan = {
  format: "four-shogi-generation-comparison-v1";
  sourceFingerprint: string;
  parent: GenerationManifest;
  candidate: GenerationManifest;
  screenSeeds: number[];
  confirmSeeds: number[];
  timeBudgetMs: number;
  threads: number;
  maxPlies: number;
  restriction: true;
  opponent: "frozen";
};
type Game = {
  key: string;
  seed: number;
  seat: Side;
  generationId: string;
  status: "in_progress" | "finished" | "truncated";
  replay: AnalysisReplayInput;
  stateHash: string;
  opening: number;
  outcome: GameArtifact["outcome"];
  rank: number | null;
  soleWin: boolean;
  eliminationStage?: number | null;
  finishReason?: string | null;
  decisions: {
    stateHash: string;
    actionId: number;
    depth: number;
    elapsedMs: number;
    modelUsed: boolean;
    withinBudget: boolean;
    memoryBytes: number;
    work: number;
    workerCpuMs: number;
    parentCpuMs: number;
  }[];
};
export function pairedSummary(
  games: readonly (Pick<Game, "seed" | "seat" | "generationId" | "status" | "rank" | "soleWin"> & {
    eliminationStage?: number | null;
    finishReason?: string | null;
  })[],
  seeds: readonly number[],
  parentId: string,
  candidateId: string,
) {
  const pairs = [];
  for (const seed of seeds)
    for (const seat of sides) {
      const a = games.find(
          (g) => g.seed === seed && g.seat === seat && g.generationId === parentId,
        ),
        b = games.find((g) => g.seed === seed && g.seat === seat && g.generationId === candidateId);
      if (a?.status === "finished" && b?.status === "finished")
        pairs.push({ base: a, candidate: b });
    }
  const baseWins = pairs.filter((p) => p.base.soleWin).length,
    candidateWins = pairs.filter((p) => p.candidate.soleWin).length;
  const baseRank = pairs.length ? pairs.reduce((n, p) => n + p.base.rank!, 0) / pairs.length : null,
    candidateRank = pairs.length
      ? pairs.reduce((n, p) => n + p.candidate.rank!, 0) / pairs.length
      : null;
  const deltas = pairs.map((p) => p.base.rank! - p.candidate.rank!),
    mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  const standardError =
    deltas.length > 1
      ? Math.sqrt(
          deltas.reduce((a, b) => a + (b - mean!) ** 2, 0) / (deltas.length - 1) / deltas.length,
        )
      : null;
  return {
    plannedPairs: seeds.length * 4,
    completedPairs: pairs.length,
    baseWins,
    candidateWins,
    baseSoleFirstRate: pairs.length ? baseWins / pairs.length : null,
    candidateSoleFirstRate: pairs.length ? candidateWins / pairs.length : null,
    baseMeanRank: baseRank,
    candidateMeanRank: candidateRank,
    rankImprovement: mean,
    pairedRankStandardError: standardError,
    baseEarlyEliminationRate: pairs.length
      ? pairs.filter((p) => (p.base.eliminationStage ?? 0) >= 3).length / pairs.length
      : null,
    candidateEarlyEliminationRate: pairs.length
      ? pairs.filter((p) => (p.candidate.eliminationStage ?? 0) >= 3).length / pairs.length
      : null,
    baseRepetitions: pairs.filter((p) => p.base.finishReason === "repetition").length,
    candidateRepetitions: pairs.filter((p) => p.candidate.finishReason === "repetition").length,
    truncated: games.filter((g) => seeds.includes(g.seed) && g.status === "truncated").length,
  };
}
export function promotionDecision(options: {
  qualified: boolean;
  criticalPassed: number;
  criticalTotal: number;
  knownPassed: number;
  knownTotal: number;
  resourcePassed: boolean;
  summary: ReturnType<typeof pairedSummary>;
  timeBudgetMs: number;
  threads: number;
}) {
  const reasons: string[] = [];
  const s = options.summary;
  if (!options.qualified) reasons.push("学習データ品質gate未達");
  if (
    options.criticalPassed !== 40 ||
    options.criticalTotal !== 40 ||
    options.knownPassed !== 8 ||
    options.knownTotal !== 8
  )
    reasons.push("重要40/40・既知8/8未達/未測定");
  if (!options.resourcePassed) reasons.push("合法性/期限/モデル実使用/資源gate未達");
  if (options.timeBudgetMs !== 5000 || options.threads !== 4)
    reasons.push("実用5秒・4workerの比較が必要");
  if (s.plannedPairs < 16 || s.completedPairs !== s.plannedPairs || s.truncated)
    reasons.push("独立した16対応条件以上の終局が不足");
  if (s.candidateWins - s.baseWins < 3) reasons.push("単独勝利+3局未達");
  if (s.rankImprovement === null || s.rankImprovement < 0.25)
    reasons.push("平均確定順位0.25改善未達");
  return {
    decision: reasons.length ? ("hold" as const) : ("promote" as const),
    reasons,
    statisticallyConfirmed: false,
  };
}
export async function runGenerationComparison(
  directory: string,
  plan: ComparisonPlan,
  signal?: AbortSignal,
) {
  const checkSource = () => {
    if (nightlySource().fingerprint !== plan.sourceFingerprint)
      throw new Error("比較ソースが事前登録と不一致です");
  };
  checkSource();
  mkdirSync(directory, { recursive: true });
  immutableJson(join(directory, "preregistration.json"), plan);
  if (
    plan.restriction !== true ||
    plan.opponent !== "frozen" ||
    new Set([...plan.screenSeeds, ...plan.confirmSeeds]).size !==
      plan.screenSeeds.length + plan.confirmSeeds.length
  )
    throw new Error("比較条件/独立seedが不正です");
  const player = await loadPlayer("frozen", {}, { temporaryDirectory: directory });
  const games: Game[] = [];
  const attemptDirectory = join(directory, "attempts");
  mkdirSync(attemptDirectory, { recursive: true });
  const priorAttempts = readdirSync(attemptDirectory).map((name) =>
    readCheckedJson<{ passed: boolean; cancelled?: boolean }>(join(attemptDirectory, name)),
  );
  let failedAttempts = priorAttempts.filter((a) => !a.passed && !a.cancelled).length,
    attemptNumber = priorAttempts.length;
  const validateSaved = async (game: Game) => {
    if (
      ![...plan.screenSeeds, ...plan.confirmSeeds].includes(game.seed) ||
      !sides.includes(game.seat) ||
      ![plan.parent.id, plan.candidate.id].includes(game.generationId) ||
      game.key !==
        dataHash({ plan, seed: game.seed, seat: game.seat, generation: game.generationId })
    )
      throw new Error("比較ゲームの識別が不一致です");
    const position = await restoreAnalysisPosition(game.replay),
      outcome = outcomeFor(position);
    const start = (await experimentStarts([true], 1, game.seed))[0];
    if (
      game.opening !== start.replay.events.length ||
      !sameData(game.replay.initial, start.replay.initial) ||
      !sameData(game.replay.events.slice(0, game.opening), start.replay.events)
    )
      throw new Error("比較の開始系列が不一致です");
    let branch = await restoreAnalysisPosition(start.replay),
      own = 0,
      eliminationStage: number | null = null;
    for (const event of game.replay.events.slice(game.opening)) {
      if (event.event.type !== "action") throw new Error("CPU比較の確定手以外を採用できません");
      if (event.event.side === game.seat) {
        const d = game.decisions[own++];
        if (
          !d ||
          d.stateHash !== branch.stateHash ||
          d.actionId !== encodeAction(event.event.action) ||
          !d.modelUsed ||
          !d.withinBudget
        )
          throw new Error("比較着手と計算記録が不一致です");
      }
      const before = getActiveSides(branch.state);
      branch = await advanceAnalysisPosition(branch, event.event);
      if (before.includes(game.seat) && !getActiveSides(branch.state).includes(game.seat))
        eliminationStage = before.length;
    }
    if (own !== game.decisions.length || (game.eliminationStage ?? null) !== eliminationStage)
      throw new Error("比較の手数/脱落段階が不一致です");
    if (position.stateHash !== game.stateHash) throw new Error("比較棋譜の完全状態が不一致です");
    if (
      game.status === "finished" &&
      (!outcome ||
        !sameData(outcome, game.outcome) ||
        game.soleWin !== (outcome.winner === game.seat) ||
        game.rank !==
          (outcome.result?.mode === "singles"
            ? outcome.result.standings.find((s) => s.side === game.seat)!.rank
            : null))
    )
      throw new Error("比較の確定順位/勝者が不一致です");
    if (
      game.status === "truncated" &&
      (outcome !== null ||
        game.outcome !== null ||
        game.replay.events.length - game.opening < plan.maxPlies)
    )
      throw new Error("比較の打切りを勝敗へ置換できません");
    if (game.status === "in_progress" && game.outcome !== null)
      throw new Error("比較途中を終局として扱えません");
    return position;
  };
  const recordFile = (seed: number, seat: Side, id: string) =>
    join(directory, dataHash({ seed, seat, id }) + ".json");
  const resources = () =>
    failedAttempts === 0 &&
    games.every((g) =>
      g.decisions.every((d) => d.modelUsed && d.withinBudget && d.memoryBytes <= 4096 * 1024 ** 2),
    );
  try {
    if (failedAttempts) {
      for (const name of readdirSync(directory).filter((n) => /^[a-f0-9]{64}\.json$/.test(n))) {
        const game = readCheckedJson<Game>(join(directory, name));
        await validateSaved(game);
        games.push(game);
      }
      return {
        status: "held_prior_failure",
        failedAttempts,
        screen: pairedSummary(games, plan.screenSeeds, plan.parent.id, plan.candidate.id),
        confirmation: pairedSummary(games, plan.confirmSeeds, plan.parent.id, plan.candidate.id),
        resourcePassed: false,
      };
    }
    for (const [phase, seeds] of [
      ["screen", plan.screenSeeds],
      ["confirmation", plan.confirmSeeds],
    ] as const) {
      for (const seed of seeds) {
        const start = (await experimentStarts([true], 1, seed))[0];
        for (const seat of sides)
          for (const generation of [plan.parent, plan.candidate]) {
            if (signal?.aborted) throw new Error("世代比較を中断しました");
            const file = recordFile(seed, seat, generation.id),
              initial = await restoreAnalysisPosition(start.replay);
            let game: Game = existsSync(file)
              ? readCheckedJson<Game>(file)
              : {
                  key: dataHash({ plan, seed, seat, generation: generation.id }),
                  seed,
                  seat,
                  generationId: generation.id,
                  status: "in_progress",
                  replay: start.replay,
                  stateHash: initial.stateHash,
                  opening: initial.eventOffset,
                  outcome: null,
                  rank: null,
                  soleWin: false,
                  decisions: [],
                };
            if (
              game.key !== dataHash({ plan, seed, seat, generation: generation.id }) ||
              !sameData(game.replay.events.slice(0, game.opening), start.replay.events)
            )
              throw new Error("比較再開の開始系列/モデルが不一致です");
            let position = await validateSaved(game);
            if (!existsSync(file)) checkedJson(file, game);
            if (position.stateHash !== game.stateHash)
              throw new Error("比較棋譜の完全状態が不一致です");
            while (game.status === "in_progress") {
              if (signal?.aborted) throw new Error("世代比較を中断しました");
              const outcome = outcomeFor(position);
              if (outcome) {
                game = {
                  ...game,
                  status: "finished",
                  outcome,
                  rank:
                    outcome.result?.mode === "singles"
                      ? outcome.result.standings.find((s) => s.side === seat)!.rank
                      : null,
                  soleWin: outcome.winner === seat,
                  finishReason: outcome.result?.reason ?? null,
                };
                checkedJson(file, game);
                break;
              }
              if (game.replay.events.length - game.opening >= plan.maxPlies) {
                game.status = "truncated";
                checkedJson(file, game);
                break;
              }
              const side = position.state.turn!;
              let action;
              if (side === seat) {
                checkSource();
                const input: StudyPositionInput = {
                  origin: { kind: "replay", replay: game.replay },
                  events: [],
                };
                const attempt = join(
                    attemptDirectory,
                    String(++attemptNumber).padStart(6, "0") + ".json",
                  ),
                  at = performance.now();
                let measured: Awaited<ReturnType<typeof runNativeStudy>> | null = null,
                  error: string | null = null;
                try {
                  measured = await runNativeStudy(
                    input,
                    generation.localModelFile && generation.modelId
                      ? {
                          file: generation.localModelFile,
                          modelId: generation.modelId,
                          sha256: generation.localModelSha256 ?? undefined,
                        }
                      : null,
                    plan.timeBudgetMs,
                    plan.threads,
                    signal,
                  );
                  checkSource();
                } catch (failure) {
                  error = String(failure);
                }
                const passed =
                  !!measured &&
                  measured.complete &&
                  measured.modelUsed &&
                  measured.withinBudget &&
                  Math.max(measured.result.memoryBytes, measured.peakWorkerRssBytes) <=
                    4096 * 1024 ** 2;
                checkedJson(attempt, {
                  gameKey: game.key,
                  eventOffset: position.eventOffset,
                  stateHash: position.stateHash,
                  replay: game.replay,
                  generationId: generation.id,
                  modelId: generation.modelId,
                  sourceFingerprint: plan.sourceFingerprint,
                  passed,
                  cancelled: signal?.aborted ?? false,
                  error,
                  elapsedMs: performance.now() - at,
                  measurement: measured,
                });
                if (!passed) {
                  if (!signal?.aborted) failedAttempts++;
                  throw new Error(
                    error ?? "比較の結果確定/モデル実使用/応答期限/RSS gateに失敗しました",
                  );
                }
                if (!measured) throw new Error("完成測定がありません");
                action = measured.result.recommendedAction!;
                game.decisions.push({
                  stateHash: position.stateHash,
                  actionId: encodeAction(action),
                  depth: measured.result.completedDepth,
                  elapsedMs: measured.elapsedMs,
                  modelUsed: measured.modelUsed,
                  withinBudget: measured.withinBudget,
                  memoryBytes: Math.max(measured.result.memoryBytes, measured.peakWorkerRssBytes),
                  workerCpuMs: measured.workerCpuMs,
                  parentCpuMs: measured.parentCpuMs,
                  work: measured.result.work,
                });
              } else action = player.selector(position.state).action;
              if (
                !action ||
                !getAnalysisLegalActions(position).some(
                  (a) => encodeAction(a) === encodeAction(action!),
                )
              )
                throw new Error("比較CPUの不正着手です");
              const event = { type: "action" as const, side, action };
              const beforeActive = getActiveSides(position.state);
              position = await advanceAnalysisPosition(position, event);
              if (beforeActive.includes(seat) && !getActiveSides(position.state).includes(seat))
                game.eliminationStage = beforeActive.length;
              const events = [...game.replay.events, { index: game.replay.events.length, event }];
              game.replay = { ...game.replay, events, eventOffset: events.length };
              game.stateHash = position.stateHash;
              checkedJson(file, game);
            }
            games.push(game);
            atomicJson(join(directory, "progress.json"), {
              phase,
              games: games.length,
              screen: pairedSummary(games, plan.screenSeeds, plan.parent.id, plan.candidate.id),
              confirmation: pairedSummary(
                games,
                plan.confirmSeeds,
                plan.parent.id,
                plan.candidate.id,
              ),
              resourcePassed: resources(),
            });
          }
      }
      const summary = pairedSummary(games, seeds, plan.parent.id, plan.candidate.id);
      if (
        phase === "screen" &&
        (summary.completedPairs !== summary.plannedPairs ||
          summary.candidateWins <= summary.baseWins ||
          summary.rankImprovement === null ||
          summary.rankImprovement <= 0)
      )
        return {
          status: "held_after_screen",
          screen: summary,
          confirmation: pairedSummary(games, plan.confirmSeeds, plan.parent.id, plan.candidate.id),
          resourcePassed: resources(),
        };
    }
    return {
      status: "completed",
      screen: pairedSummary(games, plan.screenSeeds, plan.parent.id, plan.candidate.id),
      confirmation: pairedSummary(games, plan.confirmSeeds, plan.parent.id, plan.candidate.id),
      resourcePassed: resources(),
    };
  } finally {
    player.dispose();
  }
}
if (import.meta.main) {
  const [directory, planFile, reportFile] = process.argv.slice(2);
  if (!reportFile) throw new Error("nightlyCompare directory plan report");
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    atomicJson(
      reportFile,
      await runGenerationComparison(directory, readJson(planFile), controller.signal),
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
