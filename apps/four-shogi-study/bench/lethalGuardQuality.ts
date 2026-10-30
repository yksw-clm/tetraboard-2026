import { studyTacticalCases } from "./studyTactics";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tacticalCases, acceptsTactic } from "../../../packages/four-shogi/bench/tactics";
import { getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import { createGuardedStudySearchRuntime } from "../src/search/guardedRuntime";
import { restoreStudyPosition } from "../src/domain/study";
import { tacticInput, explainLine } from "./tacticsDiagnostics";
import { timedNormal } from "./lethalGuardCase";
import { validateGuardReport, validateGuardCandidate } from "./lethalGuardValidation";
import { guardBenchIdentity } from "./lethalGuardBench";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import { fixedRootComparison } from "./tacticsImprovements";
import type { LethalGuardOptions } from "../src/search/lethalGuard";
import type { StudyCandidate } from "@tetraboard/four-shogi/study-search";
import type { FourShogiAction } from "@tetraboard/four-shogi";

export async function runGuardQuality(directory: string, planFile = "plan.json") {
  const plan = JSON.parse(readFileSync(join(directory, planFile), "utf8"));
  const file = join(directory, plan.output ?? "validation/quality.json");
  if (existsSync(file)) throw Error("既存結果は上書きしません");
  const report = {
    source: plan.source,
    conditions:
      "cold 2s wall including startup; 4worker/root/4096MiB/broadDepth3; 1000ms history measured separately",
    rows: [] as unknown[],
    skipped: [] as unknown[],
    fixed: [] as unknown[],
    complete: false,
  };
  const save = () => writeFileSync(file, JSON.stringify(report) + "\n");
  const deadline = Math.min(
    performance.now() + 25 * 60000,
    performance.now() + 90 * 60000 - (Date.now() - Date.parse(plan.registeredAt)),
  );
  for (const tactic of studyTacticalCases()) {
    const input = tacticInput(tactic.state);
    let position;
    try {
      position = await restoreStudyPosition(input);
    } catch (error) {
      if (tactic.critical) throw error;
      report.skipped.push({ id: tactic.id, reason: String(error) });
      save();
      continue;
    }
    const conditions: {
      name: string;
      strategy: "adaptive" | "dual-continuations";
      guard: LethalGuardOptions;
    }[] = [
      { name: "v5-off", strategy: "adaptive", guard: { mode: "off" } },
      { name: "p05-off", strategy: "dual-continuations", guard: { mode: "off" } },
      {
        name: "p05-observe-250",
        strategy: "dual-continuations",
        guard: { mode: "observe", budgetMs: 250 },
      },
      {
        name: "p05-experimental-250",
        strategy: "dual-continuations",
        guard: { mode: "experimental", budgetMs: 250 },
      },
      {
        name: "p05-experimental-400",
        strategy: "dual-continuations",
        guard: { mode: "experimental", budgetMs: 400 },
      },
    ];
    for (const condition of conditions) {
      if (performance.now() >= deadline) {
        save();
        return report;
      }
      if (hashJson(guardBenchIdentity()) !== hashJson(plan.source))
        throw Error("品質検証ソース不一致");
      const runtime = createGuardedStudySearchRuntime(
        { threads: 4, memoryMb: 4096, taskPartition: "root", reuseWorkers: false },
        condition.guard,
      );
      try {
        const t = await timedNormal(
          runtime,
          input,
          { strategy: condition.strategy, timeBudgetMs: 2000, broadDepth: 3 },
          2000,
        );
        const chosen = t.snapshot.candidates[0] as StudyCandidate | undefined;
        const normalEnd =
          (t.snapshot.status === "completed" &&
            ["deadline", "max_depth", "sole_win", "terminal", "lethal_guard"].includes(
              t.snapshot.reason ?? "",
            )) ||
          (condition.guard.mode === "off" &&
            t.wallStopped &&
            t.snapshot.status === "paused" &&
            t.snapshot.reason === "user");
        const accepted =
          normalEnd &&
          (tactic.family === "valid-magic"
            ? Boolean(
                chosen?.line[0]?.captured?.kind === "gold" &&
                chosen?.study?.magicEvidence?.status === "line_confirmed" &&
                chosen.study.material.lineDelta >= 500,
              )
            : acceptsTactic(tactic, t.snapshot.recommendedAction));
        if (
          t.snapshot.recommendedAction &&
          !getAnalysisLegalActions(position).some(
            (a) => JSON.stringify(a) === JSON.stringify(t.snapshot.recommendedAction),
          )
        )
          throw Error("推奨手非合法");
        for (const candidate of t.snapshot.candidates)
          await validateGuardCandidate(position, candidate);
        const proofs = t.snapshot.lethalGuard
          ? await validateGuardReport(position, t.snapshot.lethalGuard)
          : null;
        report.rows.push({
          id: tactic.id,
          critical: tactic.critical,
          condition: condition.name,
          input,
          stateHash: position.stateHash,
          accepted,
          ...t,
          proofs,
        });
        save();
        console.log(JSON.stringify({ quality: tactic.id, condition: condition.name, accepted }));
      } finally {
        await runtime.close();
      }
    }
  }
  const history = readFileSync(
    resolve(import.meta.dir, "../../../docs/four-shogi-study-p0-refinements-results.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => row.kind === "fixed");
  for (const tactic of tacticalCases().filter((t) => t.family === "inactive-rook")) {
    if (performance.now() >= deadline) {
      save();
      return report;
    }
    const input = tacticInput(tactic.state),
      position = await restoreStudyPosition(input);
    const old = history.find(
      (row) => row.data.id === tactic.id && row.data.condition.strategy === "dual-continuations",
    )?.data;
    if (!old || old.stateHash !== position.stateHash) throw Error("P0-5固定回帰の局面hash不一致");
    const actions: FourShogiAction[] = old.comparison.rows.map(
      (row: { action: FourShogiAction }) => row.action,
    );
    for (const strategy of ["dual", "dual-continuations"] as const) {
      const result = await fixedRootComparison(
        position,
        actions,
        strategy,
        9,
        { phase: "deep", width: 2, ownWidth: 3 },
        { deadline, maxWork: 2000000, taskMs: 30000 },
      );
      for (const row of result.rows)
        if (row.candidate) await validateGuardCandidate(position, row.candidate);
      report.fixed.push({
        id: tactic.id,
        strategy,
        input,
        result,
        accepted: result.complete && acceptsTactic(tactic, result.selected?.action ?? null),
        selectedLine: result.selected ? await explainLine(position, result.selected) : null,
      });
      save();
    }
  }
  report.complete = true;
  save();
  return report;
}
if (import.meta.main) await runGuardQuality(resolve(Bun.argv[2]), Bun.argv[3]);
