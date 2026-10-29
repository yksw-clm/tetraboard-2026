import { createStudySearchRuntime } from "../src/search/runtime";
import {
  measureEfficiencySearch,
  efficiencySource,
  efficiencyStrategies,
  verifyEfficiencyRows,
} from "./searchEfficiency";
const directory = Bun.argv[2];
if (!directory) throw Error("Git管理外の測定ディレクトリを指定してください");
const old = await import(directory + "/reference-d49/apps/four-shogi-study/src/search/runtime.ts");
const inputs = await Bun.file(directory + "/private-inputs/inputs.json").json();
const source = efficiencySource(),
  fingerprint = JSON.stringify(source),
  begin = performance.now(),
  results = [];
for (const index of [0, 2, 5, 15])
  for (let repeat = 0; repeat < 3; repeat++)
    for (const strategy of efficiencyStrategies)
      for (const variant of repeat % 2 ? ["optimized", "reference"] : ["reference", "optimized"]) {
        if (JSON.stringify(efficiencySource()) !== fingerprint) throw Error("source changed");
        if (performance.now() - begin > 180000) throw Error("short comparison time limit");
        const runtime = (
          variant === "reference" ? old.createStudySearchRuntime : createStudySearchRuntime
        )({ threads: 4, memoryMb: 8192, measureStages: true });
        try {
          await measureEfficiencySearch(runtime, inputs[index].input, {
            strategy,
            timeBudgetMs: 100,
          });
          const result = await measureEfficiencySearch(runtime, inputs[index].input, {
            strategy,
            timeBudgetMs: 500,
          });
          results.push({
            id: inputs[index].id,
            strategy,
            budget: 500,
            thermal: "warm",
            repeat,
            variant,
            result,
          });
          await Bun.write(
            directory + "/diagnostics/paired-short.json",
            JSON.stringify({
              source,
              referenceCommit: "d49e8c005ffffe6777f7800b622bc5b1e79793c4",
              complete: false,
              results,
            }) + "\n",
          );
        } finally {
          await runtime.close();
        }
      }
const validation = await verifyEfficiencyRows(results, inputs);
await Bun.write(
  directory + "/diagnostics/paired-short.json",
  JSON.stringify({
    source,
    referenceCommit: "d49e8c005ffffe6777f7800b622bc5b1e79793c4",
    sourceUnchanged: JSON.stringify(efficiencySource()) === fingerprint,
    complete: true,
    durationMs: performance.now() - begin,
    validation,
    results,
  }) + "\n",
);
console.log(JSON.stringify({ complete: true, rows: results.length, validation }));
