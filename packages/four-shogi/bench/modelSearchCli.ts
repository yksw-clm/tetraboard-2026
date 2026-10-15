import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cpus, release, totalmem } from "node:os";
import { analyzePosition, type AiOptions, type AiResult } from "../src/ai";
import { getAnalysisLegalActions, type AnalysisPosition } from "../src/analysis";
import { encodeAction } from "../src/actionEncoding";
import { analysisPerformanceCorpus } from "./singlesPerformance";
import { modelTacticalPositions } from "./modelSearchTactics";
import { experimentStarts, playAnalysisSingles, type PositionDecision } from "./searchExperiment";
import { hashJson, summarizeSingles, seatLineup, type SinglesSample } from "./singlesMeasurement";
import { summarizeTimes } from "./measurement";
import { repoRoot, sourceIdentity } from "./baseline";
import { startModelRuntime } from "./modelRuntime";
import { processRss } from "./selfPlayRun";
import { sides } from "../src/types";

const args = new Map<string, string>();
const known = [
  "python",
  "model-dir",
  "code-version",
  "output",
  "kind",
  "repeats",
  "max-work",
  "time-ms",
  "analysis-ms",
  "series",
  "seed",
  "max-plies",
];
for (const arg of Bun.argv.slice(2)) {
  const match = /^--([^=]+)=(.+)$/.exec(arg);
  if (!match || !known.includes(match[1]) || args.has(match[1]))
    throw new Error(`未知/重複した引数: ${arg}`);
  args.set(match[1], match[2]);
}
function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name}の範囲は${min}〜${max}です`);
  return value;
}
const directory = args.get("model-dir"),
  codeVersion = args.get("code-version"),
  output = args.get("output");
if (!directory || !codeVersion || !/^[0-9a-f]{40}$/.test(codeVersion) || !output)
  throw new Error("model-dir・40桁code-version・新規outputが必要です");
if (resolve(output).startsWith(resolve(directory) + "/"))
  throw new Error("測定結果はモデル配布物の外へ保存します");
const kind = args.get("kind") ?? "performance";
if (!["performance", "matches", "all"].includes(kind))
  throw new Error("kindはperformance/matches/allです");
const repeats = integer("repeats", 2, 1, 100),
  work = integer("max-work", 1024, 1, 1000000),
  timeMs = integer("time-ms", 100, 1, 30000);
const analysisMs = integer("analysis-ms", 0, 0, 60000),
  maxPlies = integer("max-plies", 64, 1, 2000),
  series = integer("series", 1, 1, 16),
  seed = integer("seed", 19210, 10000, 49900);
const boot = performance.now();
const runtime = await startModelRuntime({ python: args.get("python") ?? "python3", directory });
const modelId = runtime.identity.modelId;
const startupMs = performance.now() - boot;
const modes = ["static", "model", "fallback"] as const;
type Mode = (typeof modes)[number];
const base: AiOptions = {
  codeVersion,
  maxDepth: 64,
  rootWidth: 6,
  width: 3,
  extensions: 0,
  candidateCount: 3,
};
async function select(position: AnalysisPosition, mode: Mode, options: Partial<AiOptions> = {}) {
  const before = JSON.stringify(position.state);
  const started = performance.now();
  const result = await analyzePosition(
    position,
    { ...base, ...options, modelId: mode === "static" ? null : modelId },
    mode === "model"
      ? { modelEvaluator: runtime.evaluator }
      : mode === "fallback"
        ? { modelLoadError: "comparison: deliberately missing model" }
        : {},
  );
  const measuredWallMs = performance.now() - started;
  if (JSON.stringify(position.state) !== before) throw new Error("探索が入力を変更しました");
  if (
    result.recommendedAction &&
    !getAnalysisLegalActions(position).some(
      (action) => encodeAction(action) === encodeAction(result.recommendedAction!),
    )
  )
    throw new Error("比較AIが違法手を返しました");
  return { ...result, measuredWallMs };
}
function compact(result: AiResult & { measuredWallMs?: number }) {
  return {
    wallMs: result.measuredWallMs,
    input: result.input,
    settings: result.settings,
    versions: result.versions,
    model: result.model,
    diagnostics: result.diagnostics,
    recommendedAction: result.recommendedAction,
    evaluation: result.evaluation,
    candidates: result.candidates.map((candidate) => ({
      action: candidate.action,
      depth: candidate.completedDepth,
      evaluation: candidate.evaluation,
      line: candidate.line.map((step) => ({
        side: step.side,
        action: step.action,
        nextTurn: step.nextTurn,
        result: step.result,
      })),
      selective: candidate.selective,
      cutoff: candidate.cutoff,
    })),
  };
}
const report: Record<string, unknown> = {
  format: "four-shogi-model-search-comparison-v1",
  codeVersion,
  source: sourceIdentity(resolve(repoRoot, "packages/four-shogi/src")),
  runner: sourceIdentity(import.meta.dir),
  environment: {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
  },
  model: runtime.identity,
  startupMs,
  config: Object.fromEntries(args),
  complete: false,
  interpretation:
    "experimental model; not a strength/calibration certification; shared resident model in all timing modes; no actual VPS guarantee",
};
try {
  if (kind !== "matches") {
    const corpus = await analysisPerformanceCorpus();
    const rows: (ReturnType<typeof compact> & {
      name: string;
      mode: Mode;
      budget: "work" | "time";
      round: number;
      totalRssBytes: number;
    })[] = [];
    for (const budget of ["work", "time"] as const)
      for (let round = -1; round < repeats; round++)
        for (const row of corpus.positions) {
          const sequence = round % 2 === 1 ? [...modes].reverse() : modes;
          for (const mode of sequence) {
            const result = await select(row.position, mode, {
              maxWork: budget === "work" ? work : 1000000,
              timeBudgetMs: budget === "time" ? timeMs : null,
            });
            if (round >= 0)
              rows.push({
                name: row.name,
                mode,
                budget,
                round,
                ...compact(result),
                totalRssBytes: processRss(
                  runtime.client.processId ? [runtime.client.processId] : [],
                ),
              });
          }
        }
    report.performance = {
      corpusHash: hashJson(corpus.corpus),
      rows,
      summary: ["work", "time"].flatMap((budget) =>
        modes.map((mode) => {
          const selected = rows.filter((row) => row.budget === budget && row.mode === mode);
          return {
            budget,
            mode,
            ...summarizeTimes(selected.map((row) => row.wallMs!)),
            modelRuns: selected.filter((row) => row.model.usedModelId === modelId).length,
            totalRuns: selected.length,
            inferenceCount: selected.reduce((sum, row) => sum + row.model.inferenceCount, 0),
            depths: selected.map((row) => row.diagnostics.completedDepth),
            fallbacks: selected.map((row) => row.model.fallbackReason ?? null),
            maxTotalRssBytes: Math.max(...selected.map((row) => row.totalRssBytes)),
          };
        }),
      ),
    };
    const tactics = [];
    for (const row of await modelTacticalPositions())
      for (const mode of modes) {
        const result = await select(row.position, mode, {
          maxWork: 10000,
          maxDepth: 1,
          timeBudgetMs: null,
        });
        const passed =
          !!result.recommendedAction &&
          row.winningActionIds.includes(encodeAction(result.recommendedAction));
        tactics.push({
          name: row.name,
          mode,
          passed,
          expected: row.winningActionIds,
          ...compact(result),
        });
        if (!passed) throw new Error(`一手単独勝ちの回帰: ${row.name}/${mode}`);
      }
    report.tactics = {
      origin: "fixed replay prefix102 plus seed19200 random58; tuning only; exact terminal labels",
      rows: tactics,
    };
    if (analysisMs) {
      report.sharedBudget = {
        short: compact(
          await select(corpus.positions[0].position, "model", {
            timeBudgetMs: 500,
            maxWork: 1000000,
          }),
        ),
        analysis: compact(
          await select(corpus.positions[0].position, "model", {
            timeBudgetMs: analysisMs,
            maxWork: 1000000,
          }),
        ),
      };
    }
  }
  if (kind !== "performance") {
    const starts = await experimentStarts([false, true], series, seed);
    const results = [];
    for (const restricted of [false, true])
      for (const mode of modes) {
        const samples: SinglesSample[] = [];
        let requested = 0,
          used = 0,
          inferences = 0,
          modelFallbacks = 0;
        const selector =
          (choice: Mode, candidate: boolean) =>
          async (position: AnalysisPosition): Promise<PositionDecision> => {
            const result = await select(position, choice, {
              maxWork: 1000000,
              timeBudgetMs: timeMs,
            });
            if (candidate) {
              requested++;
              if (result.model.usedModelId === modelId) used++;
              inferences += result.model.inferenceCount;
              if (result.model.fallbackReason) modelFallbacks++;
            }
            return {
              action: result.recommendedAction,
              stats: {
                work: result.diagnostics.work,
                completedDepth: result.diagnostics.completedDepth,
                cutoff: result.status === "limited",
              },
              details: { model: result.model, versions: result.versions },
            };
          };
        const selectors = new Map([
          ["candidate", selector(mode, true)],
          ["opponent", selector("static", false)],
        ]);
        for (const start of starts.filter(
          (row) => row.position.state.threePlayerAttackProhibited === restricted,
        ))
          for (const seat of sides) {
            const match = await playAnalysisSingles(
              start,
              seat,
              seatLineup(seat, "candidate", ["opponent", "opponent", "opponent"]),
              selectors,
              maxPlies,
            );
            samples.push(match.sample);
          }
        results.push({
          mode,
          restricted,
          summary: summarizeSingles(samples),
          usage: { requested, used, inferences, modelFallbacks },
          samples: samples.map(({ decisions, ...sample }) => ({
            ...sample,
            decisionTiming: summarizeTimes(decisions.map((d) => d.elapsedMs)),
            work: decisions.reduce((sum, d) => sum + (d.stats?.work ?? 0), 0),
          })),
        });
      }
    report.matches = {
      opponents: "three copies of current static Maxn; no public CPU promotion",
      startMethod: "#185 seeded 12-ply legal openings",
      results,
    };
  }
  report.complete = true;
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output, modelId, complete: true, kind }));
} finally {
  runtime.client.close();
}
