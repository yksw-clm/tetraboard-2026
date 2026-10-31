import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getActiveSides } from "@tetraboard/four-shogi";
import {
  restoreAnalysisPosition,
  advanceAnalysisPosition,
  getAnalysisLegalActions,
} from "@tetraboard/four-shogi/analysis";
import { createStudySearchRuntime, type StudySearchSnapshot } from "../src/search/runtime";
import { projectFocusPosition } from "../src/search/focus";
import { guardBenchIdentity } from "./lethalGuardBench";
import { validateGuardCandidate } from "./lethalGuardValidation";

const root = Bun.argv[2];
if (!root) throw Error("artifact root required");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const save = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
if (Bun.argv[3] === "prepare") {
  const previous = readFileSync("/private/tmp/tetraboard-tprep-root", "utf8").trim();
  const games = read(join(previous, "strength/games-continuation/checkpoint.json")).rows.slice(
    0,
    4,
  );
  const cases: unknown[] = [];
  for (const row of games) {
    const replay = row.game.replay;
    let p = await restoreAnalysisPosition({ ...replay, eventOffset: 0 });
    const counts = new Set<number>();
    for (let offset = 0; offset <= replay.events.length; offset++) {
      const active = getActiveSides(p.state);
      if (offset >= 12 && p.state.status === "playing" && !counts.has(active.length)) {
        const focus = active.find((s) => s !== p.state.turn)!;
        if (focus) {
          counts.add(active.length);
          const id = `${row.job.id.slice(0, 12)}-${offset}-${focus}`;
          const value = {
            id,
            sourceGame: row.job.id,
            sourceSeed: row.job.seed,
            usedRegression: true,
            focus,
            replay: { ...replay, eventOffset: offset },
            alive: active.length,
          };
          save(join(root, "inputs", id + ".json"), value);
          cases.push({ id, file: join(root, "inputs", id + ".json"), focus, alive: active.length });
        }
      }
      if (offset < replay.events.length)
        p = await advanceAnalysisPosition(p, replay.events[offset].event);
    }
  }
  save(join(root, "baseline/cases.json"), {
    source: guardBenchIdentity(),
    cases,
    scope: "Used synthetic games, never independent strength or holdout",
  });
  console.log(JSON.stringify({ cases: cases.length }));
} else {
  const plan = read(join(root, Bun.argv[3] ?? "baseline/cases.json"));
  const output = join(root, plan.outputFile ?? "baseline/results.jsonl");
  if (existsSync(output)) throw Error("existing baseline preserved");
  for (const entry of plan.cases) {
    const input = read(entry.file),
      position = await restoreAnalysisPosition(input.replay);
    const projection = await projectFocusPosition(position, entry.focus);
    let matchedPrefix = 0;
    for (const [i, predicted] of projection.prefix.entries()) {
      const actual = input.replay.events[input.replay.eventOffset + i]?.event;
      if (
        !actual ||
        actual.type !== "action" ||
        actual.side !== predicted.side ||
        JSON.stringify(actual.action) !== JSON.stringify(predicted.action)
      )
        break;
      matchedPrefix++;
    }
    let actual = position,
      actualPlies = 0;
    while (
      actual.state.status === "playing" &&
      actual.state.turn !== entry.focus &&
      actualPlies < 12
    ) {
      const event = input.replay.events[input.replay.eventOffset + actualPlies]?.event;
      if (!event) break;
      actual = await advanceAnalysisPosition(actual, event);
      actualPlies++;
    }
    const runtime = createStudySearchRuntime({
      threads: 4,
      memoryMb: 4096,
      taskPartition: "root",
      measureStages: true,
    });
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        const budget = repeat === 0 ? 5000 : 500;
        const started = performance.now(),
          cpu = process.cpuUsage();
        let first: number | null = null;
        let final: StudySearchSnapshot;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("outer watchdog")), budget + 3000);
          void runtime
            .start(
              { origin: { kind: "replay", replay: input.replay }, events: [] },
              { strategy: "dual-continuations", focusSide: entry.focus, timeBudgetMs: budget },
              (s) => {
                if (s.completedDepth > 0 && first === null) first = performance.now() - started;
                if (["completed", "error", "cancelled"].includes(s.status)) {
                  clearTimeout(timer);
                  final = s;
                  resolve();
                }
              },
            )
            .catch((e) => {
              clearTimeout(timer);
              reject(e);
            });
        });
        const responseMs = performance.now() - started,
          used = process.cpuUsage(cpu);
        let target = position;
        for (const step of final!.focus?.prefix ?? [])
          target = await advanceAnalysisPosition(target, {
            type: "action",
            side: step.side,
            action: step.action,
          });
        for (const candidate of final!.candidates) await validateGuardCandidate(target, candidate);
        const recommended = final!.analysisRecommendedAction;
        const legal =
          !recommended ||
          getAnalysisLegalActions(target).some(
            (a) => JSON.stringify(a) === JSON.stringify(recommended),
          );
        const result = {
          id: entry.id,
          repeat,
          source: guardBenchIdentity(),
          budgetMs: budget,
          alive: entry.alive,
          focus: entry.focus,
          stateHash: position.stateHash,
          projectionStatus: projection.status,
          projectionMs: projection.elapsedMs,
          projectionWork: projection.model.work,
          prefixLength: projection.prefix.length,
          matchedPrefix,
          matchedFullPrefix:
            projection.prefix.length > 0 && matchedPrefix === projection.prefix.length,
          actualReached: actual.state.turn === entry.focus,
          actualPlies,
          projectedTargetEqualsActual: projection.analysisStateHash === actual.stateHash,
          responseMs,
          firstCompletedMs: first,
          parentCpuMs: (used.user + used.system) / 1000,
          legal,
          completed: final!.completedDepth > 0 && final!.status === "completed",
          snapshot: final!,
        };
        appendFileSync(output, JSON.stringify(result) + "\n");
        console.log(
          JSON.stringify({
            id: entry.id,
            repeat,
            responseMs,
            first,
            depth: final!.completedDepth,
            predicted: projection.prefix.length,
            matched: matchedPrefix,
            legal,
          }),
        );
      }
    } finally {
      await runtime.close();
    }
  }
  save(join(root, plan.completeFile ?? "baseline/complete.json"), {
    source: guardBenchIdentity(),
    complete: true,
    endedAt: new Date().toISOString(),
  });
}
