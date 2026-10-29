import { createStudySearchRuntime } from "../src/search/runtime";
import { tacticalCases } from "../../../packages/four-shogi/bench/tactics";
import { tacticInput } from "./tacticsDiagnostics";
import { measureEfficiencySearch, efficiencySource } from "./searchEfficiency";
const directory = Bun.argv[2];
const source = efficiencySource();
const old = await import(directory + "/reference/apps/four-shogi-study/src/search/runtime.ts");
const results = [];
for (const id of ["inactive-rook-false-north", "poisoned-gold-true-east"])
  for (const strategy of ["adaptive", "dual", "dual-continuations", "dual-quiescent"] as const)
    for (let repeat = 0; repeat < 3; repeat++)
      for (let offset = 0; offset < 3; offset++) {
        const variant = ["original", "off", "on"][(repeat + offset) % 3];
        const factory =
          variant === "original" ? old.createStudySearchRuntime : createStudySearchRuntime;
        const runtime = factory({ threads: 1, memoryMb: 8192, measureStages: variant === "on" });
        try {
          const result = await measureEfficiencySearch(
            runtime,
            tacticInput(tacticalCases().find((t) => t.id === id)!.state),
            {
              strategy,
              timeBudgetMs: 5000,
              maxDepth: 4,
              width: 2,
              rootWidth: 5,
              extensions: 0,
              dangerWork: 0,
            },
          );
          if (result.snapshot.completedDepth !== 4) throw Error("depth");
          results.push({
            id,
            strategy,
            repeat,
            variant,
            responseMs: result.responseMs,
            internalMs: result.snapshot.elapsedMs,
            depth: result.snapshot.completedDepth,
            work: result.snapshot.work,
            nodes: result.snapshot.nodes,
            candidates: result.snapshot.candidates,
          });
          await Bun.write(
            directory + "/diagnostics/measurement-overhead-optimized.json",
            JSON.stringify({ source, complete: false, results }) + "\n",
          );
        } finally {
          await runtime.close();
        }
      }
for (const r of results) {
  const base = results.find(
    (v) =>
      v.id === r.id &&
      v.strategy === r.strategy &&
      v.repeat === r.repeat &&
      v.variant === "original",
  )!;
  if (
    JSON.stringify(r.candidates) !== JSON.stringify(base.candidates) ||
    r.work !== base.work ||
    r.nodes !== base.nodes
  )
    throw Error("semantic mismatch " + r.id + " " + r.strategy + " " + r.variant);
}
await Bun.write(
  directory + "/diagnostics/measurement-overhead-optimized.json",
  JSON.stringify({
    source,
    sourceUnchanged: JSON.stringify(source) === JSON.stringify(efficiencySource()),
    complete: true,
    allOutputsMatch: true,
    results,
  }) + "\n",
);
console.log(JSON.stringify({ conditions: results.length, allOutputsMatch: true }));
