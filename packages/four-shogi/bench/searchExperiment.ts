import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, sourceIdentity } from "./baseline";
import {
  matchStarts,
  hashJson,
  resultLabels,
  type SinglesSample,
  type Start,
} from "./singlesMeasurement";
import { seededRandom, summarizeTimes } from "./measurement";
import { tacticalCases, acceptsTactic } from "./tactics";
import { searchTacticalCases, acceptsSearchTactic } from "./searchTactics";
import { analyzePosition, resolveAiOptions, type AiOptions, type AiResult } from "../src/ai";
import { createAiSearch } from "../src/aiSearch";
import { createAiMcts } from "../src/aiMcts";
import { createAiClock, runAiSession } from "../src/aiBudget";
import {
  restoreAnalysisPosition,
  advanceAnalysisPosition,
  analysisRuleProfileId,
  type AnalysisPosition,
} from "../src/analysis";
import {
  applyAction,
  createInitialState,
  getLegalActions,
  type FourShogiState,
  type Side,
} from "../src/index";
import type { AnalysisReplayInput } from "../src/analysis";

export const reference187Commit = "65380c8b2ecb44910f218c7c884e7ea92f177343";
export const experimentVariants = {
  base: { cacheSize: 0, extensions: 2 },
  cached: { cacheSize: 256, extensions: 2 },
  previous: { cacheSize: 256, extensions: 2, moveOrdering: "previous" },
  width3: { cacheSize: 256, extensions: 2, width: 3 },
  root6: { cacheSize: 256, extensions: 2, rootWidth: 6 },
  depth6: { cacheSize: 256, extensions: 2, maxDepth: 6 },
  extensions0: { cacheSize: 256, extensions: 0 },
  extensions1: { cacheSize: 256, extensions: 1 },
  extensions1NoCache: { cacheSize: 0, extensions: 1 },
  kingRing50: { cacheSize: 256, extensions: 2, evaluationWeights: { kingRing: 50 } },
  tuned: { cacheSize: 256, extensions: 1 },
  mcts: { cacheSize: 256, extensions: 1, algorithm: "mcts", seed: 188, rolloutPlies: 2 },
} satisfies Record<string, Partial<AiOptions>>;
export type VariantName = keyof typeof experimentVariants;
export function experimentOptions(
  name: VariantName,
  budget: "time" | "work",
  amount: number,
  codeVersion: string,
): AiOptions {
  return {
    codeVersion,
    modelId: null,
    maxDepth: 64,
    width: 6,
    rootWidth: 24,
    candidateCount: 3,
    maxSimulations: 1000000,
    ...experimentVariants[name],
    timeBudgetMs: budget === "time" ? amount : null,
    maxWork: budget === "work" ? amount : 100000000,
  };
}
export async function driveExperiment(state: FourShogiState, options: AiOptions) {
  const { settings } = resolveAiOptions(options);
  const now = createAiClock();
  const started = now();
  const session =
    settings.algorithm === "maxn" ? createAiSearch(state, settings) : createAiMcts(state, settings);
  const result = await runAiSession(session, settings, {}, started, now);
  return {
    ...result,
    settings,
    stats: { ...session.stats, elapsedMs: now() - started, stopReason: result.reason },
  };
}
export async function measureSearchTactics(
  names: readonly VariantName[],
  budget: "time" | "work",
  amount: number,
  codeVersion: string,
) {
  const regression = tacticalCases().filter(
    (entry) => entry.split === "regression" && entry.state.mode === "singles",
  );
  const independent = searchTacticalCases();
  const reports = [];
  for (const name of names) {
    const options = experimentOptions(name, budget, amount, codeVersion);
    const rows = [];
    for (const tactic of [...regression, ...independent]) {
      const original = hashJson(tactic.state);
      const result = await driveExperiment(tactic.state, options);
      if (hashJson(tactic.state) !== original) throw new Error("実験AIが入力を変更しました");
      const action = result.candidates[0]?.action ?? null;
      const accepted =
        "critical" in tactic ? acceptsTactic(tactic, action) : acceptsSearchTactic(tactic, action);
      rows.push({
        id: tactic.id,
        family: tactic.family,
        split: tactic.split,
        restricted: tactic.state.threePlayerAttackProhibited,
        side: tactic.state.turn,
        critical: "critical" in tactic && tactic.critical,
        stateHash: original,
        accepted,
        action,
        stats: result.stats,
        comparisonKind: result.candidates[0]?.comparisonKind ?? null,
      });
    }
    reports.push({
      name,
      options: resolveAiOptions(options).settings,
      comparisonTo:
        name === "base"
          ? "reference187-separate-engine-change"
          : name === "cached"
            ? "base"
            : name === "extensions1NoCache"
              ? "extensions1"
              : name === "mcts"
                ? "tuned"
                : "cached",
      families: new Set(rows.map((row) => row.family)).size,
      cases: rows.length,
      correct: rows.filter((row) => row.accepted).length,
      criticalFailures: rows.filter((row) => row.critical && !row.accepted).length,
      timing: summarizeTimes(rows.map((row) => row.stats.elapsedMs)),
      rows,
    });
  }
  return {
    corpusHash: hashJson([...regression, ...independent]),
    split: "tuning-and-existing-regression-only; validation-and-final-seeds-unused",
    reports,
  };
}
export type ExperimentStart = {
  start: Start;
  replay: AnalysisReplayInput;
  position: AnalysisPosition;
};
export async function experimentStarts(
  restrictions: readonly boolean[],
  count: number,
  seed: number,
): Promise<ExperimentStart[]> {
  if (seed < 10000 || seed + count > 100000)
    throw new Error("新しい調整系列は10000〜99999、最終評価系列は使用しません");
  const output: ExperimentStart[] = [];
  for (const restricted of restrictions)
    for (const start of matchStarts("opening", restricted, count, seed)) {
      const initial = {
        mode: "singles" as const,
        players: start.state.players,
        threePlayerAttackProhibited: restricted,
      };
      let state = createInitialState(initial);
      const random = seededRandom(start.seed);
      const events: AnalysisReplayInput["events"][number][] = [];
      for (let index = 0; index < 12; index++) {
        if (state.status !== "playing") throw new Error("調整開始系列が終局しました");
        const legal = getLegalActions(state);
        const action = legal[Math.floor(random() * legal.length)];
        events.push({ index, event: { type: "action", side: state.turn, action } });
        const result = applyAction(state, state.turn, action);
        if (!result.ok) throw new Error(result.reason);
        state = result.state;
      }
      const replay: AnalysisReplayInput = {
        schemaVersion: 1,
        ruleProfileId: analysisRuleProfileId,
        rulesVersion: 1,
        initial,
        events,
      };
      const position = await restoreAnalysisPosition(replay);
      if (hashJson(position.state) !== start.seriesId)
        throw new Error("#185の開始系列と復元が不一致です");
      output.push({ start, replay, position });
    }
  return output;
}
export async function loadReference187() {
  const directory = mkdtempSync(join(tmpdir(), "tetraboard-ai187-reference-"));
  try {
    const archive = Bun.spawnSync(
      ["git", "archive", reference187Commit, "packages/four-shogi/src"],
      { cwd: repoRoot },
    );
    if (archive.exitCode !== 0) throw new Error("#187基準を取得できません");
    const extraction = Bun.spawnSync(["tar", "-xf", "-", "-C", directory], {
      stdin: archive.stdout,
    });
    if (extraction.exitCode !== 0) throw new Error("#187基準を展開できません");
    const src = join(directory, "packages/four-shogi/src");
    const analysis: { restoreAnalysisPosition: typeof restoreAnalysisPosition } = await import(
      pathToFileURL(join(src, "analysis.ts")).href
    );
    const ai: { analyzePosition: typeof analyzePosition } = await import(
      pathToFileURL(join(src, "ai.ts")).href
    );
    return {
      commit: reference187Commit,
      source: sourceIdentity(src),
      restore: analysis.restoreAnalysisPosition,
      analyze: ai.analyzePosition,
      dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function measureSearchPerformance(
  names: readonly VariantName[],
  starts: readonly ExperimentStart[],
  budget: "time" | "work",
  amount: number,
  repeats: number,
  codeVersion: string,
) {
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error("反復数は正の整数です");
  const reference = await loadReference187();
  const historical = await Promise.all(starts.map((entry) => reference.restore(entry.replay)));
  const rows: {
    name: string;
    startHash: string;
    restricted: boolean;
    round: number;
    elapsedMs: number;
    rssBytes: number;
    settings: unknown;
    versions: unknown;
    stats: unknown;
    action: AiResult["recommendedAction"];
  }[] = [];
  try {
    for (let round = -1; round < repeats; round++)
      for (const [index, start] of starts.entries()) {
        // 並びによる熱・JITの偏りを減らすため、反復ごとに方式順を反転します。
        const sequence = ["reference187", ...names];
        if (round % 2 === 1) sequence.reverse();
        for (const name of sequence) {
          const before = performance.now();
          const result =
            name === "reference187"
              ? await reference.analyze(historical[index], {
                  codeVersion: reference.commit,
                  maxDepth: 64,
                  rootWidth: 24,
                  width: 6,
                  extensions: 2,
                  maxWork: budget === "work" ? amount : 100000000,
                  timeBudgetMs: budget === "time" ? amount : null,
                })
              : await analyzePosition(
                  start.position,
                  experimentOptions(name as VariantName, budget, amount, codeVersion),
                );
          const elapsedMs = performance.now() - before;
          if (round >= 0)
            rows.push({
              name,
              startHash: start.start.seriesId,
              restricted: start.position.state.threePlayerAttackProhibited,
              round,
              elapsedMs,
              rssBytes: process.memoryUsage().rss,
              settings: result.settings,
              versions: result.versions,
              stats: result.diagnostics,
              action: result.recommendedAction,
            });
        }
      }
    return {
      reference: { commit: reference.commit, source: reference.source },
      corpusHash: hashJson(starts.map((entry) => entry.start)),
      repeats,
      scope: "public-api-including-identity-preparation-and-host-yields; no-model-ipc-or-queue",
      rows,
      summary: [...new Set(rows.map((row) => row.name))].map((name) => ({
        name,
        ...summarizeTimes(rows.filter((row) => row.name === name).map((row) => row.elapsedMs)),
        maxRssBytes: Math.max(
          ...rows.filter((row) => row.name === name).map((row) => row.rssBytes),
        ),
      })),
    };
  } finally {
    reference.dispose();
  }
}
export type PositionDecision = {
  action: AiResult["recommendedAction"];
  stats: SinglesSample["decisions"][number]["stats"];
  details: unknown;
};
export type AnalysisStep = {
  before: AnalysisPosition;
  after: AnalysisPosition;
  decision: PositionDecision;
  side: Side;
  playerId: string;
  elapsedMs: number;
};
export async function playAnalysisSingles(
  start: ExperimentStart,
  seat: Side,
  lineup: Record<Side, string>,
  selectors: ReadonlyMap<string, (position: AnalysisPosition) => Promise<PositionDecision>>,
  maxPlies: number,
  onStep?: (step: AnalysisStep) => Promise<void>,
) {
  if (!Number.isSafeInteger(maxPlies) || maxPlies < 1) throw new Error("手数上限は正の整数です");
  let position = start.position;
  if (
    position.state.mode !== "singles" ||
    hashJson(position.state) !== start.start.seriesId ||
    hashJson(start.start.state) !== start.start.seriesId
  )
    throw new Error("調整開始局面のモードまたは系列識別が不一致です");
  const decisions: SinglesSample["decisions"] = [];
  const diagnostics: { side: Side; details: unknown }[] = [];
  const trajectory = new Bun.CryptoHasher("sha256").update(start.start.seriesId);
  while (position.state.status === "playing" && decisions.length < maxPlies) {
    const side = position.state.turn;
    const playerId = lineup[side];
    const selector = selectors.get(playerId);
    if (!selector) throw new Error("未登録の対局AIです");
    const original = hashJson(position.state);
    const before = performance.now();
    const decision = await selector(position);
    const elapsedMs = performance.now() - before;
    if (!decision.action || hashJson(position.state) !== original)
      throw new Error("対局AIが入力または合法着手の契約に違反しました");
    const next = await advanceAnalysisPosition(position, {
      type: "action",
      side,
      action: decision.action,
    });
    await onStep?.({ before: position, after: next, decision, side, playerId, elapsedMs });
    trajectory.update(JSON.stringify({ side, action: decision.action }));
    position = next;
    decisions.push({
      side,
      playerId,
      elapsedMs,
      rssBytes: process.memoryUsage().rss,
      stats: decision.stats,
    });
    diagnostics.push({ side, details: decision.details });
  }
  const sample: SinglesSample = {
    matchId: hashJson({ seriesId: start.start.seriesId, seat, lineup }),
    seriesId: start.start.seriesId,
    startKind: start.start.kind,
    seed: start.start.seed,
    seat,
    lineup,
    status: position.state.status === "finished" ? "finished" : "unfinished",
    moves: decisions.length,
    ...resultLabels(position.state, seat),
    termination: position.state.status === "finished" ? position.state.result!.reason : "max_plies",
    eliminations: position.state.eliminations,
    finalStateHash: hashJson(position.state),
    trajectoryHash: trajectory.digest("hex"),
    decisions,
  };
  return { sample, diagnostics };
}
