import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type StudySearchRuntime,
  type StudySearchSnapshot,
  type StudySearchOptions,
} from "../src/search/runtime";
import { createGuardedStudySearchRuntime } from "../src/search/guardedRuntime";
import {
  runLethalGuard,
  type LethalGuardOptions,
  type GuardSelection,
} from "../src/search/lethalGuard";
import { restoreStudyPosition } from "../src/domain/study";
import type { StudyPositionInput } from "../src/shared/model";
import type { StudyCandidate } from "@tetraboard/four-shogi/study-search";
import { encodeAction } from "../../../packages/four-shogi/src/actionEncoding";
import {
  proveFiniteAction,
  validateFiniteProof,
  finiteLossWitness,
} from "../../../packages/four-shogi/src/finiteSurvival";
import { validateGuardCandidate, validateGuardReport } from "./lethalGuardValidation";
import type { LossCase } from "./lossAnalysisCases";
import { guardBenchIdentity } from "./lethalGuardBench";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";

const save = (path: string, value: unknown) => {
  writeFileSync(path + ".tmp", JSON.stringify(value) + "\n");
  renameSync(path + ".tmp", path);
};
let active: StudySearchRuntime | null = null,
  stopped = false;
process.on("SIGTERM", () => {
  stopped = true;
  void active?.close();
});
process.on("SIGINT", () => {
  stopped = true;
  void active?.close();
});

export async function timedNormal(
  runtime: StudySearchRuntime,
  input: StudyPositionInput,
  options: StudySearchOptions,
  wallMs: number,
) {
  const started = performance.now();
  let wallStopped = false,
    watchdogStopped = false;
  let complete!: (s: StudySearchSnapshot) => void;
  const done = new Promise<StudySearchSnapshot>((r) => {
    complete = r;
  });
  const id = await runtime.start(input, options, (s) => {
    if (!["running"].includes(s.status)) complete(s);
  });
  const cut = setTimeout(
    () => {
      wallStopped = true;
      void runtime.pause(id);
    },
    Math.max(0, wallMs - (performance.now() - started)),
  );
  const watchdog = setTimeout(() => {
    watchdogStopped = true;
    void runtime.cancel(id);
  }, wallMs + 10000);
  try {
    const snapshot = await done;
    if (watchdogStopped) throw Error("探索watchdog上限です");
    if (snapshot.status === "error") throw Error(snapshot.reason ?? "runtime");
    return {
      snapshot: runtime.get(id) ?? snapshot,
      responseMs: performance.now() - started,
      wallStopped,
    };
  } finally {
    clearTimeout(cut);
    clearTimeout(watchdog);
  }
}

async function oneCase(directory: string, caseId: string, warm: boolean, index: number) {
  const plan = JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"));
  if (hashJson(guardBenchIdentity()) !== hashJson(plan.source))
    throw Error("固定ソースが変化しました");
  const record = JSON.parse(
    readFileSync(join(directory, "inputs", caseId + ".json"), "utf8"),
  ) as LossCase;
  const input: StudyPositionInput = {
    origin: { kind: "replay", replay: record.replay },
    events: [],
  };
  const position = await restoreStudyPosition(input);
  if (position.stateHash !== record.stateHash) throw Error("入力hashが不一致");
  const file = join(directory, "diagnostics", caseId + (warm ? "-warm" : "-cold") + ".json");
  const result = {
    caseId,
    gameId: record.gameId,
    kind: record.kind,
    side: record.side,
    restricted: record.restricted,
    warm,
    source: plan.source,
    rows: [] as unknown[],
    diagnostics: [] as unknown[],
    reproductions: [] as unknown[],
    complete: false,
  };
  const conditions: {
    name: string;
    strategy: "adaptive" | "dual-continuations";
    guard: LethalGuardOptions;
    normalMs: number;
  }[] = [
    { name: "v5-off-2000", strategy: "adaptive", guard: { mode: "off" }, normalMs: 2000 },
    {
      name: "p05-off-2000",
      strategy: "dual-continuations",
      guard: { mode: "off" },
      normalMs: 2000,
    },
    ...[100, 250, 400].flatMap((ms) => [
      {
        name: `p05-short-${ms}`,
        strategy: "dual-continuations" as const,
        guard: { mode: "off" as const },
        normalMs: 2000 - ms - 10,
      },
      {
        name: `p05-observe-${ms}`,
        strategy: "dual-continuations" as const,
        guard: { mode: "observe" as const, budgetMs: ms },
        normalMs: 2000,
      },
      {
        name: `p05-experimental-${ms}`,
        strategy: "dual-continuations" as const,
        guard: { mode: "experimental" as const, budgetMs: ms },
        normalMs: 2000,
      },
    ]),
  ];
  const offset = index % conditions.length,
    ordered = [...conditions.slice(offset), ...conditions.slice(0, offset)];
  let frozen: { snapshot: StudySearchSnapshot; shallow: StudyCandidate[] } | null = null;
  for (const condition of ordered) {
    if (stopped) break;
    let shallow: StudyCandidate[] = [];
    const config = {
      threads: 4,
      memoryMb: 4096,
      taskPartition: "root" as const,
      reuseWorkers: warm,
      measureStages: true,
      onCompletedRoots: (c: readonly StudyCandidate[], d: number) => {
        if (d === 1) shallow = structuredClone([...c]);
      },
    };
    const runtime = createGuardedStudySearchRuntime(config, condition.guard);
    active = runtime;
    try {
      if (warm)
        await timedNormal(
          runtime,
          input,
          { strategy: condition.strategy, timeBudgetMs: null, maxDepth: 1, broadDepth: 3 },
          10000,
        );
      const t = await timedNormal(
        runtime,
        input,
        { strategy: condition.strategy, timeBudgetMs: condition.normalMs, broadDepth: 3 },
        condition.normalMs,
      );
      // OFFの計測も起動/復元込みの期限で停止し、通常探索を短くした対照を別に保持します。
      if (condition.guard.mode === "off" && t.responseMs > condition.normalMs + 100)
        throw Error("OFF対照の壁時計停止が適用されていません");
      const proofs = t.snapshot.lethalGuard
        ? await validateGuardReport(position, t.snapshot.lethalGuard)
        : null;
      for (const c of t.snapshot.candidates) await validateGuardCandidate(position, c);
      if (condition.name === "p05-off-2000")
        frozen = { snapshot: t.snapshot, shallow: structuredClone(shallow) };
      result.rows.push({
        condition,
        ...t,
        proofs,
        shallowCount: shallow.length,
        withinTwoSeconds: t.responseMs <= 2000,
      });
      save(file, result);
      console.log(
        JSON.stringify({
          caseId,
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
  if (!warm && frozen && !stopped) {
    for (const budgetMs of [100, 250, 400])
      for (const selection of ["top3", "top5", "top3-reserve", "all"] as GuardSelection[]) {
        if (stopped) break;
        const report = await runLethalGuard(position, frozen.snapshot.candidates, frozen.shallow, {
          mode: "observe",
          budgetMs,
          selection,
        });
        const validation = await validateGuardReport(position, report);
        result.diagnostics.push({
          budgetMs,
          selection,
          normalSnapshotId: frozen.snapshot.id,
          report,
          validation,
          scope:
            "shared frozen 2s MaxN result; extra diagnostic time, not an equal-2s strength comparison",
        });
        save(file, result);
      }
    // 元実着手に対する診断は通常推奨との比較と分離し、相手の実手順を探索順へ渡しません。
    const chosen = record.recordedChoice.search?.candidates?.find(
      (c) => encodeAction(c.action) === encodeAction(record.chosenAction),
    );
    if (chosen)
      for (const budgetMs of [100, 250, 400]) {
        const report = await runLethalGuard(position, [chosen], [], {
          mode: "observe",
          budgetMs,
          selection: "top3",
        });
        const validation = await validateGuardReport(position, report);
        result.diagnostics.push({
          budgetMs,
          selection: "historical-chosen",
          report,
          validation,
          scope: "historical action only; diagnostic, not new policy result",
        });
        save(file, result);
      }
    if (!chosen)
      for (const budgetMs of [100, 250, 400]) {
        const proof = await proveFiniteAction(position, record.chosenAction, record.side, 4, {
          maxTransitions: 5000,
          maxMs: budgetMs / 2,
          maxWork: 100000,
          maxNodes: 4096,
          maxBytes: 16 * 1024 * 1024,
        });
        result.diagnostics.push({
          budgetMs,
          selection: "historical-forced",
          proof,
          witness: finiteLossWitness(proof),
          validation: await validateFiniteProof(position, proof),
          scope: "no original completed candidate; canonical fixed action diagnostic",
        });
        save(file, result);
      }
    const prior = JSON.parse(readFileSync(join(directory, "input-summary.json"), "utf8"));
    const old = prior.games
      .flatMap((g: { positions: unknown[] }) => g.positions)
      .find((p: { caseId: string }) => p.caseId === caseId);
    for (const a of old?.finiteAvoidance ?? [])
      for (const ms of [100, 250, 400]) {
        const action = record.legalActions.find((x) => encodeAction(x) === a.alternative)!;
        const proof = await proveFiniteAction(position, action, record.side, 4, {
          maxTransitions: 2500,
          maxMs: ms,
          maxNodes: 4096,
          maxBytes: 16 * 1024 * 1024,
        });
        result.reproductions.push({
          actionId: a.alternative,
          budgetMs: ms,
          proof,
          validation: await validateFiniteProof(position, proof),
          scope: "known-action finite proof regression; not candidate discovery",
        });
        save(file, result);
      }
  }
  result.complete = !stopped && result.rows.length === conditions.length;
  if (hashJson(guardBenchIdentity()) !== hashJson(plan.source)) throw Error("測定後のソース不一致");
  save(file, result);
  return { caseId, warm, complete: result.complete };
}

if (import.meta.main) {
  const [directory, caseId, warm, index] = Bun.argv.slice(2);
  console.log(
    JSON.stringify(await oneCase(resolve(directory), caseId, warm === "warm", Number(index))),
  );
}
