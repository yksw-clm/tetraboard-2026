import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { guardBenchIdentity } from "./lethalGuardBench";
import { git } from "../../../packages/four-shogi/bench/baseline";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import { runLethalGuard, type LethalGuardReport } from "../src/search/lethalGuard";
import { restoreStudyPosition } from "../src/domain/study";
import { validateGuardReport } from "./lethalGuardValidation";
import type { StudyCandidate } from "@tetraboard/four-shogi/study-search";
import type { LossCase } from "./lossAnalysisCases";

export const readEfficiency = <T = any>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
export const saveEfficiency = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

export function prepareEfficiency(directory: string, prior: string) {
  if (git("status", "--porcelain") || existsSync(directory))
    throw Error("固定ソースと新しい保存先が必要です");
  for (const name of [
    "inputs",
    "baseline",
    "ordering",
    "budget",
    "cache",
    "combined",
    "profiles",
    "diagnostics",
    "validation",
    "upload",
  ])
    mkdirSync(join(directory, name), { recursive: true });
  const old = readEfficiency(join(prior, "plan.json"));
  for (const c of old.cases)
    copyFileSync(join(prior, "inputs", c.id + ".json"), join(directory, "inputs", c.id + ".json"));
  const frozen = [];
  for (const name of readdirSync(join(prior, "diagnostics")).filter((n) =>
    /-(cold|warm)\.json$/.test(n),
  )) {
    const artifact = readEfficiency(join(prior, "diagnostics", name));
    const row = artifact.rows.find((r: any) => r.condition.name === "p05-experimental-250");
    const g: LethalGuardReport | undefined = row.snapshot.lethalGuard;
    if (!g) throw Error("前回のガード記録がありません");
    const pool = g.rows
      .filter((r) => r.candidate && "study" in r.candidate)
      .map((r) => r.candidate as StudyCandidate);
    const record = {
      caseId: artifact.caseId,
      warm: artifact.warm,
      kind: artifact.kind,
      stateHash: artifact.rows[0].snapshot.stateHash,
      candidates: g.originalCandidates,
      shallow: pool,
      expectedIds: g.rows.map((r) => r.actionId),
      originalReason: g.reason,
      oldRows: g.rows.map((r) => ({
        actionId: r.actionId,
        maxNRank: r.maxNRank,
        source: r.source,
        status: r.status,
        queryBudgetMs: r.queryBudgetMs,
        proofStatus: r.proof?.status,
        elapsedMs: r.proof?.elapsedMs,
        work: r.proof?.work,
        transitions: r.proof?.transitions,
        nodes: r.proof ? Object.keys(r.proof.nodes).length : 0,
        limit: r.proof?.limit,
        witness: !!r.witness,
      })),
      priorArtifact: name,
      priorSource: artifact.source,
    };
    const file = artifact.caseId + (artifact.warm ? "-warm" : "-cold") + "-frozen.json";
    saveEfficiency(join(directory, "inputs", file), record);
    frozen.push({ file, caseId: artifact.caseId, warm: artifact.warm, hash: hashJson(record) });
  }
  const plan = {
    schemaVersion: 1,
    registeredAt: new Date().toISOString(),
    source: guardBenchIdentity(),
    reference: "7338e7d24574b336a4c4e3df43c7971039122dc6",
    prior,
    environment: old.environment,
    cases: old.cases,
    warm: old.warm,
    frozen,
    limits: {
      wallMinutes: 90,
      workers: 4,
      maxWorkers: 8,
      softRssMiB: 6144,
      hardRssMiB: 7168,
      transitions: 5000,
      work: 100000,
      nodes: 4096,
      proofBytes: 16777216,
    },
    phases: {
      causeProfileMinutes: 3,
      isolatedMinutes: 7,
      endToEndMinutes: 32,
      qualityMinutes: 20,
      validationMinutes: 8,
      reserveMinutes: 20,
    },
    priority: [
      "BASE cause/profile",
      "independent ORDER simple/checks",
      "independent BUDGET four policies",
      "independent CACHE",
      "correctness and40/8",
      "COMBINED only beneficial components",
      "equal2s cold36/warm12",
      "all88",
      "saved validation",
    ],
    conditions: {
      totalMs: 2000,
      guardMs: [100, 250, 400],
      threads: 4,
      memoryMiB: 4096,
      partition: "root",
      selection: "top3-reserve",
      horizon: 4,
      broadDepth: 3,
    },
    noNewGames: true,
    noNewSeeds: true,
    default: "v5/root/OFF",
    measurementBudget:
      "Absolute 90 minutes from first registered measurement; implementation gaps remain inside wall deadline. Serial heavy phases.",
  };
  saveEfficiency(join(directory, "plan.json"), plan);
  return plan;
}

export async function efficiencyPhase(
  directory: string,
  phase: string,
  operation: (deadline: number) => Promise<void>,
) {
  const plan = readEfficiency(join(directory, "plan.json"));
  const deadlineWall = Date.parse(plan.registeredAt) + 90 * 60000;
  if (Date.now() >= deadlineWall) throw Error("全体90分を超えています");
  const resource = join(directory, "profiles", phase + "-resource");
  mkdirSync(resource, { recursive: true });
  const monitor = spawn(
    "python3",
    [
      join(import.meta.dir, "lethalGuardResourceGuard.py"),
      "--pid",
      String(process.pid),
      "--directory",
      resource,
      "--wall-seconds",
      String(Math.max(1, (deadlineWall - Date.now()) / 1000)),
    ],
    { stdio: "ignore" },
  );
  const startedAt = new Date().toISOString(),
    started = performance.now(),
    source = guardBenchIdentity();
  let success = false,
    error: string | null = null;
  try {
    await operation(performance.now() + Math.max(0, deadlineWall - Date.now()));
    success = true;
  } catch (e) {
    error = String(e);
    throw e;
  } finally {
    monitor.kill("SIGTERM");
    await new Promise<void>((r) => monitor.once("exit", () => r()));
    saveEfficiency(join(directory, "profiles", phase + "-phase.json"), {
      phase,
      startedAt,
      endedAt: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      source,
      success,
      error,
      sourceUnchanged: hashJson(source) === hashJson(guardBenchIdentity()),
    });
  }
}

export async function profileEfficiency(directory: string) {
  const plan = readEfficiency(join(directory, "plan.json"));
  const results: unknown[] = [];
  await efficiencyPhase(directory, "phase-a", async (deadline) => {
    for (const f of plan.frozen) {
      if (performance.now() >= deadline) break;
      const saved = readEfficiency(join(directory, "inputs", f.file));
      if (hashJson(saved) !== f.hash) throw Error("凍結候補hash不一致");
      const record = readEfficiency<LossCase>(join(directory, "inputs", saved.caseId + ".json"));
      const p = await restoreStudyPosition({
        origin: { kind: "replay", replay: record.replay },
        events: [],
      });
      const g = await runLethalGuard(p, saved.candidates, saved.shallow, {
        mode: "observe",
        budgetMs: 250,
        measureStages: true,
      });
      if (JSON.stringify(g.rows.map((r) => r.actionId)) !== JSON.stringify(saved.expectedIds))
        throw Error("凍結候補集合が変わりました: " + saved.caseId);
      const validation = await validateGuardReport(p, g);
      results.push({
        caseId: saved.caseId,
        warm: saved.warm,
        kind: saved.kind,
        source: guardBenchIdentity(),
        guard: g,
        validation,
      });
      saveEfficiency(join(directory, "profiles/phase-a.json"), {
        source: guardBenchIdentity(),
        results,
        complete: false,
      });
      console.log(
        JSON.stringify({
          phase: "A",
          caseId: saved.caseId,
          warm: saved.warm,
          unknown: g.rows.filter((r) => r.status === "unknown").length,
        }),
      );
    }
    saveEfficiency(join(directory, "profiles/phase-a.json"), {
      source: guardBenchIdentity(),
      results,
      complete: results.length === plan.frozen.length,
    });
  });
}

if (import.meta.main) {
  const [command, directory, prior] = Bun.argv.slice(2);
  if (command === "prepare")
    console.log(JSON.stringify(prepareEfficiency(resolve(directory), resolve(prior))));
  else if (command === "profile") await profileEfficiency(resolve(directory));
  else throw Error("prepare/profile を指定してください");
}
