import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, release, totalmem } from "node:os";
import { git, repoRoot, sourceIdentity } from "../../../packages/four-shogi/bench/baseline";
import {
  tacticalCases,
  acceptsTactic,
  tacticalFixtureVersion,
} from "../../../packages/four-shogi/bench/tactics";
import {
  getAnalysisLegalActions,
  advanceAnalysisPosition,
  type AnalysisPosition,
} from "../../../packages/four-shogi/src/analysis";
import { getCheckState } from "../../../packages/four-shogi/src/board";
import {
  createStudyRootSearch,
  compareStudyCandidates,
  explainStudyEvaluation,
  type StudySearchStrategy,
  type StudyTaskPolicy,
  type StudyCandidate,
} from "../../../packages/four-shogi/src/studySearch";
import type { FourShogiAction } from "../../../packages/four-shogi/src/types";
import { restoreStudyPosition } from "../src/domain/study";
import { actionKey, tacticInput, drainTask, explainLine, digest } from "./tacticsDiagnostics";

export const improvementStrategies = [
  "dual",
  "dual-promotions",
  "dual-extensions",
  "dual-combined",
] as const;

/** 全根が完了した同一条件だけを比較します。未完成候補は選択へ混ぜません。 */
export async function fixedRootComparison(
  position: AnalysisPosition,
  actions: readonly FourShogiAction[],
  strategy: StudySearchStrategy,
  depth: number,
  policy: StudyTaskPolicy,
  limits: { deadline: number; maxWork: number; taskMs: number },
) {
  const legal = getAnalysisLegalActions(position);
  const indices = [
    ...new Set(actions.map((action) => legal.findIndex((a) => actionKey(a) === actionKey(action)))),
  ].sort((a, b) => a - b);
  if (!indices.length || indices.some((i) => i < 0))
    throw new Error("比較初手が合法手にありません");
  const search = createStudyRootSearch(position, { strategy, extensions: 2, cacheSize: 8192 });
  const rows: {
    rootIndex: number;
    action: FourShogiAction;
    completion: ReturnType<typeof drainTask>;
    elapsedMs: number;
    nodes: number;
    extendedNodes: number;
    promotionExtraMoves: number;
    candidate: StudyCandidate | null;
  }[] = [];
  try {
    const prep = drainTask(
      search,
      Math.min(limits.deadline, performance.now() + limits.taskMs),
      true,
      limits.maxWork,
    );
    if (!prep.complete) return { complete: false, prep, rows, selected: null };
    for (const index of indices) {
      const before = search.snapshot();
      const started = performance.now();
      search.startTask(index, depth, false, policy);
      const completion = drainTask(
        search,
        Math.min(limits.deadline, performance.now() + limits.taskMs),
        false,
        limits.maxWork,
      );
      const elapsedMs = performance.now() - started;
      const after = search.snapshot();
      const candidate = completion.complete ? after.candidates[0] : null;
      rows.push({
        rootIndex: index,
        action: legal[index],
        completion,
        elapsedMs,
        nodes: after.stats.nodes - before.stats.nodes,
        extendedNodes: after.stats.extendedNodes - before.stats.extendedNodes,
        promotionExtraMoves:
          after.performance!.promotionExtraMoves - before.performance!.promotionExtraMoves,
        candidate,
      });
      if (performance.now() >= limits.deadline) break;
    }
    const complete = rows.length === indices.length && rows.every((row) => row.completion.complete);
    const candidates = rows.map((r) => r.candidate).filter((c): c is StudyCandidate => c !== null);
    candidates.sort((a, b) => compareStudyCandidates(a, b, position.state.turn!));
    return { complete, prep, rows, selected: complete ? candidates[0] : null };
  } finally {
    search.dispose();
  }
}

async function leafEvidence(position: AnalysisPosition, candidate: StudyCandidate) {
  const line = await explainLine(position, candidate);
  const current = line.finalPosition;
  const root = position.state.turn!;
  const replies = [];
  for (const action of getAnalysisLegalActions(current)) {
    const next = await advanceAnalysisPosition(current, {
      type: "action",
      side: current.state.turn!,
      action,
    });
    const captured = next.state.lastMove?.captured;
    if (captured?.side === root || next.state.eliminations.some((e) => e.side === root)) {
      replies.push({ action, captured, evaluation: explainStudyEvaluation(next).evaluation });
    }
  }
  return {
    states: line.states,
    finalStateHash: line.finalStateHash,
    evaluationMatches: line.evaluationMatches,
    explained: line.explained,
    turn: current.state.turn,
    checked: getCheckState(current.state),
    eliminations: current.state.eliminations,
    repliesCapturingRoot: replies,
  };
}

const identity = () => ({
  commit: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain").length > 0,
  engine: sourceIdentity(resolve(repoRoot, "packages/four-shogi/src")),
  runtime: sourceIdentity(resolve(repoRoot, "apps/four-shogi-study/src/search")),
  bench: sourceIdentity(resolve(repoRoot, "apps/four-shogi-study/bench")),
  fixtures: sourceIdentity(resolve(repoRoot, "packages/four-shogi/bench")),
});

export async function runImprovementComparison(options: {
  mode: "fixed" | "poison";
  output: string;
  maxMinutes: number;
  caseId?: string;
}) {
  if (!(options.maxMinutes > 0 && options.maxMinutes <= 30))
    throw new Error("固定比較の上限は30分です");
  if (await Bun.file(options.output).exists()) throw new Error("既存結果は上書きしません");
  const source = identity();
  const sourceHash = digest(source);
  const historicalText = await readFile(
    resolve(repoRoot, "docs/four-shogi-study-tactics-diagnostics-results.json"),
    "utf8",
  );
  const historical = JSON.parse(historicalText) as {
    cases: {
      id: string;
      observed: { cohort: StudyCandidate[] };
      originalActions: Record<string, FourShogiAction>;
    }[];
    summary: { confirmedSelectionFailures: string[] };
  };
  const deadline = performance.now() + options.maxMinutes * 60_000;
  const report = {
    schemaVersion: 1,
    mode: options.mode,
    source,
    sourceUnchanged: true,
    startedAt: new Date().toISOString(),
    endedAt: "",
    fixtureVersion: tacticalFixtureVersion,
    historicalSha256: new Bun.CryptoHasher("sha256").update(historicalText).digest("hex"),
    environment: {
      bun: Bun.version,
      os: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    limits: {
      maxMinutes: options.maxMinutes,
      taskMs: options.mode === "poison" ? 60_000 : 30_000,
      maxWork: options.mode === "poison" ? 10_000_000 : 2_000_000,
    },
    results: [] as unknown[],
    completedComparisons: 0,
    incompleteComparisons: 0,
    complete: true,
  };
  const cases = tacticalCases().filter(
    (t) =>
      (!options.caseId || t.id === options.caseId) &&
      (options.mode === "poison"
        ? t.family === "poisoned-gold"
        : historical.summary.confirmedSelectionFailures.includes(t.id) ||
          t.family === "poisoned-gold"),
  );
  for (const tactic of cases) {
    const input = tacticInput(tactic.state);
    const position = await restoreStudyPosition(input);
    const old = historical.cases.find((t) => t.id === tactic.id)!;
    const expected = getAnalysisLegalActions(position).filter((action) =>
      acceptsTactic(tactic, action),
    );
    const actions = [
      ...old.observed.cohort.map((c) => c.action),
      ...expected,
      ...Object.values(old.originalActions),
    ];
    const conditions =
      options.mode === "fixed"
        ? improvementStrategies.map((strategy) => ({ strategy, depth: 9, width: 2, ownWidth: 3 }))
        : [
            ...(["dual", "dual-combined"] as const).flatMap((strategy) =>
              [4, 6, 8].map((depth) => ({ strategy, depth, width: 2, ownWidth: 3 })),
            ),
            ...[6, 9].map((depth) => ({
              strategy: "dual-combined" as const,
              depth,
              width: 4,
              ownWidth: 6,
            })),
            { strategy: "dual-combined" as const, depth: 6, width: 8, ownWidth: 10 },
          ];
    for (const condition of conditions) {
      if (performance.now() >= deadline) {
        report.complete = false;
        break;
      }
      if (digest(identity()) !== sourceHash) throw new Error("比較中にソースが変わりました");
      const comparison = await fixedRootComparison(
        position,
        actions,
        condition.strategy,
        condition.depth,
        { phase: "deep", width: condition.width, ownWidth: condition.ownWidth },
        { ...report.limits, deadline },
      );
      if (comparison.complete) report.completedComparisons++;
      else report.incompleteComparisons++;
      const evidence = [];
      if (tactic.family === "poisoned-gold")
        for (const row of comparison.rows)
          if (row.candidate) {
            const after = await advanceAnalysisPosition(position, {
              type: "action",
              side: position.state.turn!,
              action: row.candidate.action,
            });
            evidence.push({
              rootIndex: row.rootIndex,
              expected: acceptsTactic(tactic, row.candidate.action),
              afterRoot: explainStudyEvaluation(after),
              leaf: await leafEvidence(position, row.candidate),
            });
          }
      const row = {
        id: tactic.id,
        input,
        stateHash: position.stateHash,
        expected,
        condition,
        comparison,
        evidence,
        accepted: comparison.selected ? acceptsTactic(tactic, comparison.selected.action) : null,
      };
      report.results.push(row);
      console.log(
        JSON.stringify({
          id: tactic.id,
          ...condition,
          complete: comparison.complete,
          accepted: row.accepted,
        }),
      );
      report.sourceUnchanged = digest(identity()) === sourceHash;
      report.endedAt = new Date().toISOString();
      await writeFile(options.output + ".tmp", JSON.stringify(report) + "\n");
      await rename(options.output + ".tmp", options.output);
    }
    if (!report.complete) break;
  }
  report.complete &&= report.results.length === cases.length * (options.mode === "fixed" ? 4 : 9);
  report.endedAt = new Date().toISOString();
  await writeFile(options.output, JSON.stringify(report) + "\n");
  return report;
}

if (import.meta.main) {
  const args = new Map(
    Bun.argv.slice(2).map((a) => {
      const m = /^--([a-z-]+)=(.+)$/.exec(a);
      if (!m) throw new Error(`invalid argument ${a}`);
      return [m[1], m[2]];
    }),
  );
  const mode = args.get("mode") ?? "fixed";
  if (mode !== "fixed" && mode !== "poison") throw new Error("mode must be fixed or poison");
  await runImprovementComparison({
    mode,
    output: args.get("output")!,
    maxMinutes: Number(args.get("max-minutes") ?? 20),
    caseId: args.get("case-id"),
  });
}
