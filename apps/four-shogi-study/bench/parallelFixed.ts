import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createStudySearchRuntime } from "../src/search/runtime";
import { parallelTrial, verifyParallelFile } from "./parallelSearch";
import { efficiencySource } from "./searchEfficiency";
import { tacticalCases, acceptsTactic } from "../../../packages/four-shogi/bench/tactics";
import {
  createStudyRootSearch,
  compareStudyCandidates,
  type StudyCandidate,
  type StudySubtreeResult,
  type StudySearchStrategy,
} from "../../../packages/four-shogi/src/studySearch";
import { getAnalysisLegalActions } from "../../../packages/four-shogi/src/analysis";
import { restoreStudyPosition } from "../src/domain/study";
import { tacticInput, explainLine } from "./tacticsDiagnostics";
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const semantic = (c: readonly StudyCandidate[]) =>
  c.map((value) => ({ ...value, iterationWork: 0, iterationNodes: 0 }));
export async function runParallelFixed(directory: string, outputStem = "fixed-runtime") {
  if (!/^[a-z0-9-]{1,64}$/.test(outputStem)) throw new Error("固定検証の出力名が不正です");
  const source = efficiencySource(),
    fingerprint = digest(source),
    begin = performance.now();
  const inputs = await Bun.file(join(directory, "private-inputs/inputs.json")).json(),
    file = join(directory, `validation/${outputStem}.jsonl`);
  if (await Bun.file(file).exists()) throw Error("既存の測定を上書きしません");
  const guard = () => {
    if (digest(efficiencySource()) !== fingerprint) throw Error("ソース変更です");
    if (performance.now() - begin > 10 * 60000) throw Error("固定検証10分上限です");
  };
  await Bun.write(
    file,
    JSON.stringify({
      kind: "header",
      source,
      conditions: {
        P5: { indices: "all16", workers: [1, 2, 4, 8], depth: 5, cacheSizes: [0, 8192] },
        dual: { indices: [0, 2, 5, 15], workers: [4, 8], depth: 5, cacheSizes: [0] },
        adaptive: { indices: [0, 2, 5, 15], workers: [1, 8], depth: 3, cacheSizes: [0] },
      },
      defaultBroad3: {
        indices: [0, 2, 5, 15],
        strategy: "dual-continuations",
        workers: [4, 8],
        depth: 5,
        cacheSizes: [0, 8192],
        width: 6,
        rootWidth: 24,
      },
      limits: {
        maxMinutes: 10,
        perSearchMs: 30000,
        maxWork: 2000000,
        memoryMiB: 8192,
        maxWorkers: 8,
      },
    }) + "\n",
  );
  const comparisons: any[] = [];
  let searches = 0;
  const jobs: {
    strategy: StudySearchStrategy;
    index: number;
    cacheSize: number;
    threads: number;
    depth: number;
    broadDepth: number;
    width: number;
    rootWidth: number;
  }[] = [];
  for (const strategy of ["adaptive", "dual", "dual-continuations"] as StudySearchStrategy[])
    for (let index = 0; index < inputs.length; index++) {
      if (strategy !== "dual-continuations" && ![0, 2, 5, 15].includes(index)) continue;
      for (const cacheSize of strategy === "dual-continuations" ? [0, 8192] : [0])
        for (const threads of strategy === "dual"
          ? [4, 8]
          : strategy === "adaptive"
            ? [1, 8]
            : [1, 2, 4, 8])
          jobs.push({
            strategy,
            index,
            cacheSize,
            threads,
            depth: strategy === "adaptive" ? 3 : 5,
            broadDepth: 2,
            width: 2,
            rootWidth: 5,
          });
    }
  for (const index of [0, 2, 5, 15])
    for (const cacheSize of [0, 8192])
      for (const threads of [4, 8])
        jobs.push({
          strategy: "dual-continuations",
          index,
          cacheSize,
          threads,
          depth: 5,
          broadDepth: 3,
          width: 6,
          rootWidth: 24,
        });
  for (const job of jobs) {
    const { strategy, index, cacheSize, threads } = job;
    const pair: any[] = [];
    for (let offset = 0; offset < 2; offset++) {
      guard();
      const taskPartition = (index + offset) % 2 ? "replies" : "root";
      const runtime = createStudySearchRuntime({
        threads,
        memoryMb: 8192,
        taskPartition,
        measureStages: true,
      });
      try {
        const result = await parallelTrial(
          runtime,
          inputs[index].input,
          {
            strategy,
            timeBudgetMs: 30000,
            maxDepth: job.depth,
            broadDepth: job.broadDepth,
            width: job.width,
            rootWidth: job.rootWidth,
            extensions: 0,
            dangerWork: 0,
            cacheSize,
          },
          2000000,
        );
        const row = {
          kind: "search",
          id: inputs[index].id,
          strategy,
          variant: taskPartition,
          cacheSize,
          threads,
          condition: job,
          thermal: "cold",
          result,
        };
        pair.push(row);
        await appendFile(file, JSON.stringify(row) + "\n");
        searches++;
      } finally {
        await runtime.close();
      }
    }
    const old = pair.find((r) => r.variant === "root").result.snapshot,
      next = pair.find((r) => r.variant === "replies").result.snapshot;
    const complete = [old, next].every(
      (s) => s.status === "completed" && ["max_depth", "sole_win", "terminal"].includes(s.reason),
    );
    const audit = (s: any) =>
      s.work -
      (s.performance.preparationWork ?? 0) -
      (s.performance.rootSetupWork ?? 0) -
      s.performance.immediateWork -
      s.performance.materialWork -
      (s.performance.completedIterationWork ?? 0);
    const row = {
      id: inputs[index].id,
      strategy,
      threads,
      cacheSize,
      condition: job,
      complete,
      rootAuditDifference: audit(old),
      repliesAuditDifference: audit(next),
      algorithmWorkMatch:
        old.performance.completedIterationWork === next.performance.completedIterationWork,
      rootAlgorithmWork: old.performance.completedIterationWork,
      repliesAlgorithmWork: next.performance.completedIterationWork,
      depth: next.completedDepth,
      depthMatch: old.completedDepth === next.completedDepth,
      candidateMatch: digest(old.candidates) === digest(next.candidates),
      semanticMatch: digest(semantic(old.candidates)) === digest(semantic(next.candidates)),
      recommendedMatch: digest(old.recommendedAction) === digest(next.recommendedAction),
      workMatch: old.work === next.work,
      nodesMatch: old.nodes === next.nodes,
      rootWork: old.work,
      repliesWork: next.work,
      rootResponseMs: pair.find((r) => r.variant === "root").result.responseMs,
      repliesResponseMs: pair.find((r) => r.variant === "replies").result.responseMs,
    };
    comparisons.push(row);
    await appendFile(file, JSON.stringify({ kind: "comparison", ...row }) + "\n");
    console.log(JSON.stringify(row));
  }
  const pv = await verifyParallelFile(directory, file),
    allMatch = comparisons.every(
      (r) =>
        r.complete &&
        r.depthMatch &&
        r.semanticMatch &&
        r.recommendedMatch &&
        r.rootAuditDifference === 0 &&
        r.repliesAuditDifference === 0 &&
        (r.cacheSize !== 0 || (r.candidateMatch && r.algorithmWorkMatch)),
    );
  const report = {
    source,
    sourceUnchanged: digest(efficiencySource()) === fingerprint,
    complete: true,
    allMatch,
    searches,
    pv,
    comparisons,
    physicalWorkMatches: comparisons.filter((r) => r.workMatch).length,
    physicalWorkMismatches: comparisons.filter((r) => !r.workMatch),
    contract:
      "cache=0 requires complete candidate including iteration work/nodes equality. Physical worker totals include root setup and differ with task ownership; never rewrite them. Normal cache compares semantic candidate and separately records real work.",
  };
  await Bun.write(
    join(directory, `validation/${outputStem}-summary.json`),
    JSON.stringify(report) + "\n",
  );
  await appendFile(
    file,
    JSON.stringify({
      kind: "footer",
      allMatch,
      searches,
      sourceUnchanged: report.sourceUnchanged,
    }) + "\n",
  );
  return report;
}

/** 固定深さ9の既知8展開。性能測定ではなく、同じ根集合の品質検証です。 */
export async function runKnownParallelTactics(directory: string) {
  const source = efficiencySource(),
    fingerprint = digest(source),
    begin = performance.now(),
    rows: any[] = [];
  const report = { source, sourceUnchanged: true, complete: false, allMatch: true, rows };
  const path = join(directory, "validation/known-depth9.json");
  if (await Bun.file(path).exists()) throw Error("既存の測定を上書きしません");
  for (const tactic of tacticalCases().filter((t) => t.family === "inactive-rook")) {
    const position = await restoreStudyPosition(tacticInput(tactic.state)),
      legal = getAnalysisLegalActions(position);
    const indices = [
      ...new Set(
        [...legal.slice(0, 2), ...legal.filter((a) => acceptsTactic(tactic, a))].map((a) =>
          legal.findIndex((v) => digest(v) === digest(a)),
        ),
      ),
    ].sort((a, b) => a - b);
    for (const cacheSize of [0, 8192]) {
      const pair: any[] = [];
      for (const partition of [false, true]) {
        if (digest(efficiencySource()) !== fingerprint) throw Error("ソース変更です");
        if (performance.now() - begin > 8 * 60000) throw Error("既知8展開の8分上限です");
        const sessions = Array.from({ length: partition ? 3 : 1 }, () =>
          createStudyRootSearch(position, {
            strategy: "dual-continuations",
            cacheSize,
            maxDepth: 9,
            extensions: 2,
            dangerWork: 0,
          }),
        );
        const owner = sessions[0],
          candidates: StudyCandidate[] = [];
        let complete = true,
          splits = 0,
          steps = 0;
        const deadline = performance.now() + 30000;
        const check = () => {
          if (performance.now() >= deadline || sessions.reduce((n, s) => n + s.work, 0) > 2000000) {
            complete = false;
            return false;
          }
          return true;
        };
        const drain = (search: ReturnType<typeof createStudyRootSearch>, prep = false) => {
          while (check()) {
            if (search.step() || (prep && search.depth >= 1)) return true;
            if (++steps % 1000 === 0 && !check()) return false;
          }
          return false;
        };
        try {
          for (const s of sessions) if (!drain(s, true)) break;
          for (const index of indices) {
            if (!complete) break;
            owner.startTask(index, 9, false, { phase: "deep", width: 2, ownWidth: 3 }, partition);
            while (check()) {
              const done = owner.step(),
                plan = owner.takeSplitPlan();
              if (plan) {
                splits++;
                const results: StudySubtreeResult[] = [];
                for (const [slot, task] of [...plan.tasks].reverse().entries()) {
                  const helper = sessions[1 + (slot % 2)];
                  helper.startSubtree(structuredClone(task));
                  if (!drain(helper)) break;
                  results.push(helper.subtreeResult()!);
                }
                if (!complete) break;
                owner.finishSplitPlan(plan.planId, results);
              } else if (done) {
                candidates.push(owner.snapshot().candidates[0]);
                break;
              }
            }
          }
          candidates.sort((a, b) => compareStudyCandidates(a, b, position.state.turn!));
          const pv = [];
          for (const candidate of candidates) {
            const explained = await explainLine(position, candidate);
            pv.push({
              rootIndex: candidate.rootIndex,
              match: explained.evaluationMatches,
              finalStateHash: explained.finalStateHash,
            });
          }
          const row = {
            id: tactic.id,
            cacheSize,
            partition: partition ? "replies" : "root",
            complete: complete && candidates.length === indices.length,
            accepted: candidates.length ? acceptsTactic(tactic, candidates[0].action) : false,
            depth: 9,
            indices,
            splits,
            candidates,
            pv,
            physicalWork: sessions.reduce((n, s) => n + s.work, 0),
          };
          rows.push(row);
          pair.push(row);
          console.log(
            JSON.stringify({
              id: row.id,
              cacheSize,
              partition: row.partition,
              complete: row.complete,
              accepted: row.accepted,
              splits,
            }),
          );
        } finally {
          sessions.forEach((s) => s.dispose());
        }
      }
      const equal =
        digest(cacheSize === 0 ? pair[0].candidates : semantic(pair[0].candidates)) ===
        digest(cacheSize === 0 ? pair[1].candidates : semantic(pair[1].candidates));
      report.allMatch &&=
        equal && pair.every((r) => r.complete && r.accepted && r.pv.every((p: any) => p.match));
      await Bun.write(path, JSON.stringify(report) + "\n");
    }
  }
  report.complete = true;
  report.sourceUnchanged = digest(efficiencySource()) === fingerprint;
  await Bun.write(path, JSON.stringify(report) + "\n");
  return report;
}
