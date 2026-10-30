import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { validateFiniteProof } from "../../../packages/four-shogi/src/finiteSurvival";
import { join, resolve } from "node:path";
import { restoreStudyPosition } from "../src/domain/study";
import type { LossCase } from "./lossAnalysisCases";
import { validateGuardCandidate, validateGuardReport } from "./lethalGuardValidation";

const quantile = (xs: number[], p: number) => {
  const a = [...xs].sort((a, b) => a - b);
  return a.length ? a[Math.max(0, Math.ceil(p * a.length) - 1)] : null;
};
export async function collectGuardResults(directory: string) {
  const plan = JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"));
  const inputSummary = JSON.parse(readFileSync(join(directory, "input-summary.json"), "utf8"));
  const modelGames = new Set(
    inputSummary.games
      .filter((g: { modelWitnessObserved: boolean }) => g.modelWitnessObserved)
      .map((g: { gameId: string }) => g.gameId),
  );
  const cases = [],
    rows: {
      caseId: string;
      warm: boolean;
      kind: string;
      condition: string;
      [key: string]: unknown;
    }[] = [];
  const totals = { pv: 0, pvSteps: 0, certificates: 0, verified: 0, witnesses: 0, cases: 0 };
  for (const name of readdirSync(join(directory, "diagnostics")).filter((n) =>
    /-cold\.json$|-warm\.json$/.test(n),
  )) {
    const artifact = JSON.parse(readFileSync(join(directory, "diagnostics", name), "utf8"));
    const record = JSON.parse(
      readFileSync(join(directory, "inputs", artifact.caseId + ".json"), "utf8"),
    ) as LossCase;
    const position = await restoreStudyPosition({
      origin: { kind: "replay", replay: record.replay },
      events: [],
    });
    const validate = async (report: Parameters<typeof validateGuardReport>[1]) => {
      const v = await validateGuardReport(position, report);
      totals.certificates += v.certificates;
      totals.verified += v.verified;
      totals.witnesses += v.witnesses;
    };
    for (const row of artifact.rows) {
      const snapshot = row.snapshot;
      for (const candidate of snapshot.candidates) {
        const v = await validateGuardCandidate(position, candidate);
        totals.pv++;
        totals.pvSteps += v.steps;
      }
      if (snapshot.lethalGuard) await validate(snapshot.lethalGuard);
      const g = snapshot.lethalGuard;
      rows.push({
        caseId: artifact.caseId,
        warm: artifact.warm,
        kind: record.kind,
        condition: row.condition.name,
        responseMs: row.responseMs,
        withinTwoSeconds: row.responseMs <= 2000,
        depth: snapshot.completedDepth,
        maxNDepth: g?.maxNCompletedDepth ?? snapshot.completedDepth,
        deep:
          snapshot.timing?.deepStartedMs !== null && snapshot.timing?.deepStartedMs !== undefined,
        publishedDeep: snapshot.coverage?.phase === "deep",
        forced: record.legalActions.length === 1,
        alive: record.activeSides.length,
        normalElapsedMs: g?.normalElapsedMs ?? row.responseMs,
        work: snapshot.work,
        nodes: snapshot.nodes,
        memoryBytes: snapshot.memoryBytes,
        guardMs: g?.elapsedMs ?? 0,
        guardWork: g?.work ?? 0,
        guardTransitions: g?.transitions ?? 0,
        guardEstimatedBytes: g?.estimatedBytes ?? 0,
        safe: g?.rows.filter((r: { status: string }) => r.status === "safe").length ?? 0,
        unsafe: g?.rows.filter((r: { status: string }) => r.status === "unsafe").length ?? 0,
        unknown: g?.rows.filter((r: { status: string }) => r.status === "unknown").length ?? 0,
        targets: g?.rows.length ?? 0,
        witnesses: g?.rows.filter((r: { witness: unknown }) => r.witness).length ?? 0,
        changed: g?.changed ?? false,
        wouldChange: g?.wouldChange ?? false,
        action: snapshot.recommendedAction,
        originalAction: g?.originalAction ?? snapshot.recommendedAction,
      });
    }
    for (const d of artifact.diagnostics) if (d.report) await validate(d.report);
    for (const d of artifact.diagnostics) if (d.proof) await validateFiniteProof(position, d.proof);
    for (const item of artifact.reproductions) await validateFiniteProof(position, item.proof);
    const historical = artifact.diagnostics
      .filter((d: { selection: string }) => d.selection === "historical-chosen")
      .map((d: { budgetMs: number; report: { rows: { status: string; witness: unknown }[] } }) => ({
        budgetMs: d.budgetMs,
        status: d.report.rows[0]?.status ?? "unknown",
        witness: Boolean(d.report.rows[0]?.witness),
      }));
    for (const d of artifact.diagnostics.filter(
      (d: { selection: string }) => d.selection === "historical-forced",
    ))
      historical.push({
        budgetMs: d.budgetMs,
        status: d.proof.elapsedMs <= d.budgetMs / 2 ? d.proof.status : "unknown",
        witness: Boolean(d.witness),
      });
    cases.push({
      caseId: artifact.caseId,
      gameId: record.gameId,
      kind: record.kind,
      role: record.role,
      warm: artifact.warm,
      complete: artifact.complete,
      modelGame: modelGames.has(record.gameId),
      historical,
      reproductions: artifact.reproductions,
      frozenPolicies: artifact.diagnostics
        .filter((d: { selection: string }) => d.selection !== "historical-chosen")
        .map(
          (d: {
            budgetMs: number;
            selection: string;
            report: { wouldChange: boolean; rows: { status: string; actionId: number }[] };
          }) => ({
            budgetMs: d.budgetMs,
            selection: d.selection,
            wouldChange: d.report.wouldChange,
            roots: d.report.rows.map((r) => ({ actionId: r.actionId, status: r.status })),
          }),
        ),
    });
    totals.cases++;
  }
  const groups = [];
  const qualityFile = join(
    directory,
    existsSync(join(directory, "validation/quality-corrected.json"))
      ? "validation/quality-corrected.json"
      : "validation/quality.json",
  );
  if (existsSync(qualityFile)) {
    const quality = JSON.parse(readFileSync(qualityFile, "utf8"));
    for (const row of quality.rows) {
      const position = await restoreStudyPosition(row.input);
      if (position.stateHash !== row.stateHash) throw Error("品質検証の保存入力hash不一致");
      for (const c of row.snapshot.candidates) {
        const v = await validateGuardCandidate(position, c);
        totals.pv++;
        totals.pvSteps += v.steps;
      }
      if (row.snapshot.lethalGuard) {
        const v = await validateGuardReport(position, row.snapshot.lethalGuard);
        totals.certificates += v.certificates;
        totals.verified += v.verified;
        totals.witnesses += v.witnesses;
      }
    }
    for (const row of quality.fixed) {
      const position = await restoreStudyPosition(row.input);
      for (const item of row.result.rows)
        if (item.candidate) await validateGuardCandidate(position, item.candidate);
    }
  }
  for (const warm of [false, true])
    for (const condition of plan.conditions.matrix) {
      const r = rows.filter((r) => r.warm === warm && r.condition === condition),
        nums = (k: string) => r.map((v) => Number(v[k]));
      if (!r.length) continue;
      const targets = nums("targets").reduce((a, b) => a + b, 0),
        unknown = nums("unknown").reduce((a, b) => a + b, 0);
      groups.push({
        warm,
        condition,
        n: r.length,
        responseP50: quantile(nums("responseMs"), 0.5),
        responseP95: quantile(nums("responseMs"), 0.95),
        over2s: r.filter((x) => !x.withinTwoSeconds).length,
        maxNDepthMedian: quantile(nums("maxNDepth"), 0.5),
        depth2: r.filter((x) => Number(x.maxNDepth) >= 2).length,
        deep: r.filter((x) => x.deep).length,
        nonforced: r.filter((x) => !x.forced).length,
        nonforcedDepth2: r.filter((x) => !x.forced && Number(x.maxNDepth) >= 2).length,
        nonforcedDeep: r.filter((x) => !x.forced && x.deep).length,
        guardP50: quantile(nums("guardMs"), 0.5),
        guardP95: quantile(nums("guardMs"), 0.95),
        targets,
        unknown,
        completionRate: targets ? (targets - unknown) / targets : null,
        changed: r.filter((x) => x.changed).length,
        wouldChange: r.filter((x) => x.wouldChange).length,
        workMean: nums("work").reduce((a, b) => a + b, 0) / r.length,
        guardWorkMean: nums("guardWork").reduce((a, b) => a + b, 0) / r.length,
        rssReportedMax: Math.max(...nums("memoryBytes")),
        controlChanges: r.filter((x) => x.kind === "win-control" && x.changed).map((x) => x.caseId),
      });
    }
  const summary = {
    schemaVersion: 1,
    source: plan.source,
    conditions: plan.conditions,
    totals,
    groups,
    cases,
    rows,
    scope:
      "used correlated seed9874100 diagnostics; no independent strength certification. Frozen policies share exact MaxN results but use extra diagnostic time.",
  };
  writeFileSync(
    join(directory, "validation/serialized-results.json"),
    JSON.stringify({ totals, allValid: true }) + "\n",
  );
  writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}
if (import.meta.main) {
  const s = await collectGuardResults(resolve(Bun.argv[2]));
  console.log(JSON.stringify({ totals: s.totals, groups: s.groups }));
}
