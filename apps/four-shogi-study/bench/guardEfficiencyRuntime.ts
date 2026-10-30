import { join, resolve } from "node:path";
import { existsSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { readEfficiency as read, saveEfficiency as save, efficiencyPhase } from "./guardEfficiency";
import { guardBenchIdentity } from "./lethalGuardBench";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import { git } from "../../../packages/four-shogi/bench/baseline";
import { createGuardedStudySearchRuntime } from "../src/search/guardedRuntime";
import { runLethalGuard, type LethalGuardOptions } from "../src/search/lethalGuard";
import { timedNormal } from "./lethalGuardCase";
import { restoreStudyPosition } from "../src/domain/study";
import { validateGuardReport, validateGuardCandidate } from "./lethalGuardValidation";
import type { StudySearchRuntime } from "../src/search/runtime";
import type { LossCase } from "./lossAnalysisCases";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import {
  proveFiniteAction,
  validateFiniteProof,
} from "../../../packages/four-shogi/src/finiteSurvival";
import { orderGuardReplies } from "../src/search/guardReplyOrder";

const atomic = (p: string, v: unknown) => {
  writeFileSync(p + ".tmp", JSON.stringify(v) + "\n");
  renameSync(p + ".tmp", p);
};
let active: StudySearchRuntime | null = null,
  stopped = false;
const stop = () => {
  stopped = true;
  void active?.close();
};

export async function runEfficiencyCase(
  directory: string,
  id: string,
  warm: boolean,
  index: number,
) {
  const plan = read(join(directory, "runtime-plan.json"));
  if (hashJson(plan.source) !== hashJson(guardBenchIdentity())) throw Error("実行ソース不一致");
  const record = read<LossCase>(join(directory, "inputs", id + ".json"));
  const input = { origin: { kind: "replay" as const, replay: record.replay }, events: [] };
  const rows: any[] = [],
    conditions = [
      ...plan.conditions.slice(index % plan.conditions.length),
      ...plan.conditions.slice(0, index % plan.conditions.length),
    ];
  const output = join(directory, "diagnostics", id + (warm ? "-warm" : "-cold") + "-runtime.json");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    for (const condition of conditions) {
      if (stopped) break;
      const runtime = createGuardedStudySearchRuntime(
        {
          threads: 4,
          memoryMb: 4096,
          taskPartition: "root",
          reuseWorkers: warm,
          measureStages: true,
        },
        condition.guard,
      );
      active = runtime;
      try {
        if (warm)
          await timedNormal(
            runtime,
            input,
            { strategy: "dual-continuations", timeBudgetMs: null, maxDepth: 1, broadDepth: 3 },
            10000,
          );
        const startWall = Date.now();
        const t = await timedNormal(
          runtime,
          input,
          { strategy: "dual-continuations", timeBudgetMs: condition.normalMs, broadDepth: 3 },
          condition.normalMs,
        );
        const endWall = Date.now();
        rows.push({ condition, startWall, endWall, ...t, withinTwoSeconds: t.responseMs <= 2000 });
        atomic(output, {
          source: plan.source,
          caseId: id,
          warm,
          kind: record.kind,
          forced: record.legalActions.length === 1,
          rows,
          complete: false,
        });
        console.log(
          JSON.stringify({
            caseId: id,
            warm,
            condition: condition.name,
            depth: t.snapshot.completedDepth,
            responseMs: Math.round(t.responseMs),
            changed: t.snapshot.lethalGuard?.changed ?? false,
          }),
        );
      } finally {
        await runtime.close();
        active = null;
      }
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
  atomic(output, {
    source: plan.source,
    caseId: id,
    warm,
    kind: record.kind,
    forced: record.legalActions.length === 1,
    rows,
    complete: rows.length === conditions.length,
  });
  if (stopped) throw Error("中断しました");
}

export async function runEfficiencyMatrix(directory: string, specification: string) {
  const plan = read(join(directory, "plan.json")),
    spec = read(specification);
  if (git("status", "--porcelain")) throw Error("固定ソースが必要です");
  const source = guardBenchIdentity();
  const conditions: { name: string; guard: LethalGuardOptions; normalMs: number }[] =
    spec.variants.flatMap((v: any) =>
      [100, 250, 400].map((budgetMs) => ({
        name: v.name + "-" + budgetMs,
        guard: { mode: "experimental", budgetMs, measureStages: true, ...v.options },
        normalMs: 2000,
      })),
    );
  conditions.push(
    { name: "OFF-2000", guard: { mode: "off" }, normalMs: 2000 },
    { name: "SHORT-250", guard: { mode: "off" }, normalMs: 1740 },
    {
      name: "OBSERVE-250",
      guard: { mode: "observe", budgetMs: 250, measureStages: true, ...spec.combined },
      normalMs: 2000,
    },
  );
  const registration = {
    ...spec,
    source,
    registeredAt: plan.registeredAt,
    phaseRegisteredAt: new Date().toISOString(),
    conditions,
  };
  if (existsSync(join(directory, "runtime-plan.json"))) throw Error("実行計画を上書きしません");
  save(join(directory, "runtime-plan.json"), registration);
  let child: ReturnType<typeof spawn> | null = null;
  const completed: any[] = [],
    failures: any[] = [];
  const interrupt = () => {
    stopped = true;
    child?.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  await efficiencyPhase(directory, "runtime", async (deadline) => {
    try {
      for (const [index, job] of [
        ...plan.cases.map((c: any) => ({ id: c.id, warm: false })),
        ...plan.warm.map((id: string) => ({ id, warm: true })),
      ].entries()) {
        if (stopped || performance.now() >= deadline) break;
        child = spawn(
          process.execPath,
          [import.meta.path, "case", directory, job.id, job.warm ? "warm" : "cold", String(index)],
          { detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        const pid = child.pid!;
        let error = "";
        child.stdout!.on("data", (b) => process.stdout.write(b));
        child.stderr!.on("data", (b) => (error = (error + String(b)).slice(-4000)));
        const timer = setTimeout(() => child?.kill("SIGTERM"), 90000);
        const hard = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }, 95000);
        const code = await new Promise<number | null>((r) => child!.once("exit", r));
        clearTimeout(timer);
        clearTimeout(hard);
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
        child = null;
        if (code === 0) completed.push(job);
        else failures.push({ ...job, code, error: error.replaceAll(directory, "<ARTIFACT_ROOT>") });
        save(join(directory, "runtime-checkpoint.json"), {
          source,
          completed,
          failures,
          stopped,
          sourceUnchanged: hashJson(source) === hashJson(guardBenchIdentity()),
        });
        if (code !== 0) break;
      }
    } finally {
      child?.kill("SIGTERM");
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
    if (failures.length || stopped || completed.length !== 48)
      throw Error("runtime比較が未完了です");
  });
}

export async function runFrozenMatrix(directory: string, specification: string) {
  const plan = read(join(directory, "plan.json")),
    spec = read(specification),
    source = guardBenchIdentity();
  save(join(directory, "frozen-plan.json"), {
    ...spec,
    source,
    registeredAt: new Date().toISOString(),
    scope: "Same saved candidate sets; extra diagnostic time, not equal2s strength test.",
  });
  await efficiencyPhase(directory, "frozen", async (deadline) => {
    for (const [index, f] of plan.frozen.entries()) {
      const saved = read(join(directory, "inputs", f.file)),
        record = read<LossCase>(join(directory, "inputs", saved.caseId + ".json"));
      const p = await restoreStudyPosition({
        origin: { kind: "replay", replay: record.replay },
        events: [],
      });
      const rows: any[] = [];
      const variants = [
        ...spec.variants.slice(index % spec.variants.length),
        ...spec.variants.slice(0, index % spec.variants.length),
      ];
      for (const budgetMs of [100, 250, 400])
        for (const v of variants) {
          if (performance.now() >= deadline) throw Error("全体予算終了");
          const guard = await runLethalGuard(p, saved.candidates, saved.shallow, {
            mode: "observe",
            budgetMs,
            measureStages: true,
            ...v.options,
          });
          if (
            JSON.stringify(guard.rows.map((r) => r.actionId)) !== JSON.stringify(saved.expectedIds)
          )
            throw Error("凍結候補が異なります");
          rows.push({ variant: v.name, budgetMs, guard });
        }
      atomic(
        join(
          directory,
          "diagnostics",
          saved.caseId + (saved.warm ? "-warm" : "-cold") + "-frozen-results.json",
        ),
        { source, caseId: saved.caseId, warm: saved.warm, kind: saved.kind, rows, complete: true },
      );
      console.log(JSON.stringify({ frozen: saved.caseId, warm: saved.warm, rows: rows.length }));
    }
  });
}

export async function verifyEfficiency(directory: string) {
  const counts = { reports: 0, certificates: 0, verified: 0, witnesses: 0, pv: 0, pvSteps: 0 },
    records: any[] = [];
  await efficiencyPhase(directory, "serialized", async (deadline) => {
    const files = readdirSync(join(directory, "diagnostics")).filter((n) =>
      /-runtime\.json$|-frozen-results\.json$/.test(n),
    );
    for (const name of files) {
      if (performance.now() >= deadline) throw Error("照合予算終了");
      const a = read(join(directory, "diagnostics", name)),
        record = read<LossCase>(join(directory, "inputs", a.caseId + ".json"));
      const p = await restoreStudyPosition({
        origin: { kind: "replay", replay: record.replay },
        events: [],
      });
      for (const row of a.rows) {
        const g = row.guard ?? row.snapshot?.lethalGuard;
        if (g) {
          const result = await validateGuardReport(p, g);
          counts.reports++;
          counts.certificates += result.certificates;
          counts.verified += result.verified;
          counts.witnesses += result.witnesses;
        }
        for (const c of row.snapshot?.candidates ?? []) {
          const r = await validateGuardCandidate(p, c);
          counts.pv++;
          counts.pvSteps += r.steps;
        }
      }
      records.push({ name, complete: a.complete, rows: a.rows.length });
      save(join(directory, "validation/serialized.json"), {
        source: guardBenchIdentity(),
        counts,
        records,
        complete: false,
      });
    }
    const quality = read(join(directory, "validation/quality.json"));
    for (const row of quality.rows) {
      const p = await restoreStudyPosition(row.input);
      for (const c of row.snapshot.candidates) {
        const r = await validateGuardCandidate(p, c);
        counts.pv++;
        counts.pvSteps += r.steps;
      }
      if (row.snapshot.lethalGuard) {
        const r = await validateGuardReport(p, row.snapshot.lethalGuard);
        counts.reports++;
        counts.certificates += r.certificates;
        counts.verified += r.verified;
        counts.witnesses += r.witnesses;
      }
    }
    for (const row of quality.fixed) {
      const p = await restoreStudyPosition(row.input);
      for (const x of row.result.rows)
        if (x.candidate) await validateGuardCandidate(p, x.candidate);
    }
    save(join(directory, "validation/serialized.json"), {
      source: guardBenchIdentity(),
      counts,
      records,
      complete: true,
    });
  });
}

export async function knownEfficiency(directory: string) {
  const results: any[] = [];
  await efficiencyPhase(directory, "known", async () => {
    for (const id of ["ae960d72d889183a-95", "f1c8fdef9f37da03-146"]) {
      const record = read<LossCase>(join(directory, "inputs", id + ".json")),
        f = read(join(directory, "inputs", id + "-cold-frozen.json"));
      const p = await restoreStudyPosition({
        origin: { kind: "replay", replay: record.replay },
        events: [],
      });
      // P1-4bの既知証明を再現する診断だけで使い、通常候補の順序へ渡しません。
      const actions = f.oldRows
        .filter((r: any) =>
          id.startsWith("ae") ? r.actionId === 9988 : [3450, 3451].includes(r.actionId),
        )
        .map(
          (r: any) =>
            f.shallow.find((c: any) => encodeAction(c.action) === r.actionId)?.action ??
            f.candidates.find((c: any) => encodeAction(c.action) === r.actionId)?.action,
        );
      const chosen = f.candidates[0].action;
      for (const action of [chosen, ...actions])
        for (const order of ["base", "simple", "checks"] as const) {
          const proof = await proveFiniteAction(p, action, record.side, 4, {
            maxTransitions: 5000,
            maxWork: 100000,
            maxNodes: 4096,
            maxBytes: 16777216,
            maxMs: 2000,
            order: (p, a) => orderGuardReplies(p, a, record.side, order),
          });
          const validation = await validateFiniteProof(p, proof);
          results.push({ id, action, order, proof, validation });
          save(join(directory, "validation/known.json"), {
            source: guardBenchIdentity(),
            results,
            complete: false,
          });
        }
    }
    save(join(directory, "validation/known.json"), {
      source: guardBenchIdentity(),
      results,
      complete: true,
    });
  });
}

if (import.meta.main) {
  const [command, directory, a, b, c] = Bun.argv.slice(2);
  const root = resolve(directory);
  if (command === "case") await runEfficiencyCase(root, a, b === "warm", Number(c));
  else if (command === "runtime") await runEfficiencyMatrix(root, resolve(a));
  else if (command === "frozen") await runFrozenMatrix(root, resolve(a));
  else if (command === "verify") await verifyEfficiency(root);
  else if (command === "known") await knownEfficiency(root);
  else throw Error("case/runtime/frozen/verify/known を指定してください");
}
