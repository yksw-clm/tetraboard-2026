import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, release, totalmem } from "node:os";
import { git, repoRoot, sourceIdentity } from "../../../packages/four-shogi/bench/baseline";
import {
  tacticalCases,
  acceptsTactic,
  tacticalFixtureVersion,
} from "../../../packages/four-shogi/bench/tactics";
import { getAnalysisLegalActions } from "../../../packages/four-shogi/src/analysis";
import { getCheckState } from "../../../packages/four-shogi/src/board";
import {
  createStudyRootSearch,
  type StudySearchStrategy,
  type StudyCandidate,
} from "../../../packages/four-shogi/src/studySearch";
import { restoreStudyPosition } from "../src/domain/study";
import { createStudySearchRuntime, type StudySearchSnapshot } from "../src/search/runtime";
import { fixedRootComparison } from "./tacticsImprovements";
import { tacticInput, drainTask, explainLine, digest } from "./tacticsDiagnostics";

export const refinementStrategies = [
  "dual",
  "dual-continuations",
  "dual-quiescent",
  "dual-refined",
] as const;
export function refinementVarianceIds(
  rows: readonly { id: string; strategy: string; accepted: boolean }[],
) {
  const ids = new Set(["inactive-rook-false-north", "poisoned-gold-true-east"]);
  for (const row of rows)
    if (
      !row.accepted &&
      refinementStrategies.slice(1).some((s) => s === row.strategy) &&
      rows.some(
        (other) =>
          other.id === row.id &&
          other.accepted &&
          !refinementStrategies.slice(1).some((s) => s === other.strategy),
      )
    )
      ids.add(row.id);
  return [...ids].sort();
}
const fixedStrategies = [
  "dual",
  "dual-promotions",
  "dual-extensions",
  "dual-combined",
  ...refinementStrategies.slice(1),
] as const;
export const refinementIdentity = () => ({
  commit: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain").length > 0,
  engine: sourceIdentity(resolve(repoRoot, "packages/four-shogi/src")),
  runtime: sourceIdentity(resolve(repoRoot, "apps/four-shogi-study/src/search")),
  bench: sourceIdentity(resolve(repoRoot, "apps/four-shogi-study/bench")),
  fixtures: sourceIdentity(resolve(repoRoot, "packages/four-shogi/bench")),
});

export async function runRefinementDiagnostics(options: {
  mode: "fixed" | "controls" | "profile" | "variance";
  output: string;
  maxMinutes: number;
  caseId?: string;
  tacticsFrom?: string;
}) {
  if (!(options.maxMinutes > 0 && options.maxMinutes <= 20)) throw new Error("調査上限は20分です");
  if (await Bun.file(options.output).exists()) throw new Error("既存結果は上書きしません");
  const source = refinementIdentity(),
    fingerprint = digest(source),
    deadline = performance.now() + options.maxMinutes * 60_000;
  const history = JSON.parse(
    await readFile(
      resolve(repoRoot, "docs/four-shogi-study-tactics-diagnostics-results.json"),
      "utf8",
    ),
  ) as {
    cases: {
      id: string;
      observed: { cohort: StudyCandidate[] };
      originalActions: Record<string, StudyCandidate["action"]>;
    }[];
  };
  const prior = JSON.parse(
    await readFile(resolve(repoRoot, "docs/four-shogi-study-p0-improvements-results.json"), "utf8"),
  );
  const report = {
    schemaVersion: 1,
    mode: options.mode,
    startedAt: new Date().toISOString(),
    endedAt: "",
    source,
    sourceUnchanged: true,
    fixtureVersion: tacticalFixtureVersion,
    contextInputs: await Promise.all(
      [
        "docs/four-shogi-study-tactics-diagnostics-results.json",
        "docs/four-shogi-study-p0-improvements-results.json",
      ].map(async (path) => ({
        path,
        sha256: new Bun.CryptoHasher("sha256")
          .update(await Bun.file(resolve(repoRoot, path)).arrayBuffer())
          .digest("hex"),
      })),
    ),
    varianceRequestedIds: [] as string[],
    varianceUnavailableIds: [] as string[],
    environment: {
      bun: Bun.version,
      os: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    limits: {
      maxMinutes: options.maxMinutes,
      maxWork: 2_000_000,
      taskMs: 30_000,
      cacheStates: 8192,
    },
    results: [] as unknown[],
    complete: true,
  };
  async function save() {
    report.endedAt = new Date().toISOString();
    report.sourceUnchanged = digest(refinementIdentity()) === fingerprint;
    await writeFile(options.output + ".tmp", JSON.stringify(report) + "\n");
    await rename(options.output + ".tmp", options.output);
  }
  const varianceIds =
    options.mode === "variance" && options.tacticsFrom
      ? refinementVarianceIds((await Bun.file(options.tacticsFrom).json()).results)
      : refinementVarianceIds([]);
  const cases = tacticalCases().filter(
    (t) =>
      (options.mode === "variance"
        ? varianceIds.includes(t.id)
        : t.family === "inactive-rook" || t.id === "poisoned-gold-true-east") &&
      (!options.caseId || t.id === options.caseId),
  );
  if (!cases.length) throw new Error("対象展開がありません");
  if (options.mode === "variance") {
    report.varianceRequestedIds = varianceIds;
    report.varianceUnavailableIds = varianceIds.filter((id) => !cases.some((t) => t.id === id));
  }
  for (const tactic of cases) {
    if (
      options.mode === "controls" &&
      !["inactive-rook-false-north", "poisoned-gold-true-east"].includes(tactic.id)
    )
      continue;
    if (
      options.mode === "profile" &&
      !["inactive-rook-false-north", "poisoned-gold-true-east"].includes(tactic.id)
    )
      continue;
    const input = tacticInput(tactic.state),
      position = await restoreStudyPosition(input),
      legal = getAnalysisLegalActions(position);
    const old = history.cases.find((t) => t.id === tactic.id)!;
    const expected = legal.filter((action) => acceptsTactic(tactic, action));
    const previousRuntime =
      tactic.id === "inactive-rook-false-north"
        ? prior.regressionDiagnostic.results.find(
            (r: { id: string; kind: string; strategy: string }) =>
              r.id === tactic.id && r.kind === "time" && r.strategy === "dual",
          )
        : null;
    const cohort = previousRuntime?.snapshot.candidates as StudyCandidate[] | undefined;
    const baseActions =
      options.mode === "variance"
        ? []
        : [
            ...(cohort ?? old.observed.cohort).map((c) => c.action),
            ...expected,
            ...Object.values(old.originalActions),
          ];
    if (options.mode === "variance") {
      for (let repeat = 0; repeat < 3; repeat++)
        for (let offset = 0; offset < 6; offset++) {
          if (performance.now() >= deadline) {
            report.complete = false;
            break;
          }
          if (digest(refinementIdentity()) !== fingerprint) throw new Error("ソースが変わりました");
          const strategies = [
            "dual",
            "adaptive",
            "dual-promotions",
            "dual-continuations",
            "dual-quiescent",
            "dual-refined",
          ] as const;
          const strategy = strategies[(repeat + offset) % strategies.length];
          const runtime = createStudySearchRuntime({ threads: 4, memoryMb: 8192 });
          try {
            let finish!: (value: StudySearchSnapshot) => void;
            const done = new Promise<StudySearchSnapshot>((resolve) => {
              finish = resolve;
            });
            await runtime.start(input, { strategy, timeBudgetMs: 1000 }, (value) => {
              if (value.status === "completed" || value.status === "error") finish(value);
            });
            const snapshot = await done;
            report.results.push({
              id: tactic.id,
              input,
              stateHash: position.stateHash,
              strategy,
              repeat,
              accepted: acceptsTactic(tactic, snapshot.recommendedAction),
              snapshot,
            });
            console.log(
              JSON.stringify({
                id: tactic.id,
                strategy,
                repeat,
                depth: snapshot.completedDepth,
                accepted: acceptsTactic(tactic, snapshot.recommendedAction),
              }),
            );
          } finally {
            await runtime.close();
          }
          await save();
        }
    } else if (options.mode === "profile") {
      const actions = [
        ...new Map(
          [expected[0], old.originalActions.dual].map((a) => [JSON.stringify(a), a]),
        ).values(),
      ];
      for (const strategy of ["dual-extensions", "dual-quiescent", "dual-refined"] as const)
        for (const extensions of [0, 1, 2])
          for (const action of actions) {
            if (performance.now() >= deadline) {
              report.complete = false;
              break;
            }
            if (digest(refinementIdentity()) !== fingerprint)
              throw new Error("ソースが変わりました");
            const profile: Record<
              string,
              {
                nodes: number;
                legal: number;
                ranked: number;
                selected: number;
                rankingWork: number;
              }
            > = {};
            const search = createStudyRootSearch(
              position,
              { strategy, extensions, cacheSize: 8192 },
              {
                profileExtension: (e) => {
                  const v = (profile[e.reason] ??= {
                    nodes: 0,
                    legal: 0,
                    ranked: 0,
                    selected: 0,
                    rankingWork: 0,
                  });
                  v.nodes++;
                  v.legal += e.legalMoves;
                  v.ranked += e.rankedMoves;
                  v.selected += e.selectedMoves;
                  v.rankingWork += e.rankingWork;
                },
              },
            );
            try {
              const prep = drainTask(search, Math.min(deadline, performance.now() + 30000), true);
              const index = legal.findIndex((a) => JSON.stringify(a) === JSON.stringify(action));
              if (prep.complete)
                search.startTask(index, 9, false, { phase: "deep", width: 2, ownWidth: 3 });
              const start = performance.now();
              const completion = prep.complete
                ? drainTask(search, Math.min(deadline, start + 30000))
                : prep;
              const snapshot = search.snapshot();
              const candidate = completion.complete ? snapshot.candidates[0] : null;
              const evidence = candidate ? await explainLine(position, candidate) : null;
              report.results.push({
                id: tactic.id,
                input,
                stateHash: position.stateHash,
                strategy,
                extensions,
                rootIndex: index,
                action,
                prep,
                completion,
                elapsedMs: performance.now() - start,
                profile,
                snapshot,
                evidence: evidence
                  ? {
                      states: evidence.states,
                      finalStateHash: evidence.finalStateHash,
                      explained: evidence.explained,
                      evaluationMatches: evidence.evaluationMatches,
                    }
                  : null,
              });
              console.log(
                JSON.stringify({
                  id: tactic.id,
                  strategy,
                  extensions,
                  index,
                  complete: completion.complete,
                  work: completion.work,
                }),
              );
            } finally {
              search.dispose();
            }
            await save();
            Bun.gc(true);
          }
    } else {
      const conditions =
        options.mode === "fixed"
          ? fixedStrategies.map((strategy) => ({
              strategy,
              depth: 9,
              width: 2,
              ownWidth: 3,
              roots: "cohort",
            }))
          : tactic.family === "inactive-rook"
            ? ["dual", "dual-promotions", "dual-continuations"].flatMap((strategy) =>
                [
                  [2, 3],
                  [2, 4],
                  [3, 3],
                ].flatMap(([width, ownWidth]) =>
                  ["cohort", "all"].map((roots) => ({
                    strategy,
                    depth: 9,
                    width,
                    ownWidth,
                    roots,
                  })),
                ),
              )
            : [
                "dual",
                "dual-promotions",
                "dual-continuations",
                "dual-quiescent",
                "dual-refined",
              ].flatMap((strategy) =>
                [4, 6, 8].map((depth) => ({
                  strategy,
                  depth,
                  width: 2,
                  ownWidth: 3,
                  roots: "cohort",
                })),
              );
      for (const condition of conditions) {
        if (performance.now() >= deadline) {
          report.complete = false;
          break;
        }
        if (digest(refinementIdentity()) !== fingerprint) throw new Error("ソースが変わりました");
        const actions = condition.roots === "all" ? legal : baseActions;
        const comparison = await fixedRootComparison(
          position,
          actions,
          condition.strategy as StudySearchStrategy,
          condition.depth,
          { phase: "deep", width: condition.width, ownWidth: condition.ownWidth },
          { deadline, maxWork: 2_000_000, taskMs: 30_000 },
        );
        const evidence = [];
        for (const row of comparison.rows)
          if (row.candidate) {
            const line = await explainLine(position, row.candidate);
            evidence.push({
              rootIndex: row.rootIndex,
              states: line.states,
              finalStateHash: line.finalStateHash,
              explained: line.explained,
              checked: getCheckState(line.finalPosition.state),
              evaluationMatches: line.evaluationMatches,
            });
          }
        const result = {
          id: tactic.id,
          input,
          stateHash: position.stateHash,
          expected,
          condition,
          comparison,
          evidence,
          accepted: comparison.selected ? acceptsTactic(tactic, comparison.selected.action) : null,
        };
        report.results.push(result);
        console.log(
          JSON.stringify({
            id: tactic.id,
            ...condition,
            complete: comparison.complete,
            accepted: result.accepted,
          }),
        );
        await save();
        Bun.gc(true);
      }
    }
    if (!report.complete) break;
  }
  await save();
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
  if (!["fixed", "controls", "profile", "variance"].includes(mode))
    throw new Error("mode must be fixed, controls, profile or variance");
  if (!args.get("output")) throw new Error("output is required");
  await runRefinementDiagnostics({
    mode: mode as "fixed" | "controls" | "profile" | "variance",
    output: args.get("output")!,
    maxMinutes: Number(args.get("max-minutes") ?? 15),
    caseId: args.get("case-id"),
    tacticsFrom: args.get("tactics-from"),
  });
}
