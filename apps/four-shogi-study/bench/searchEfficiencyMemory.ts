import { createStudySearchRuntime } from "../src/search/runtime";
import {
  efficiencySource,
  measureEfficiencySearch,
  verifyEfficiencyRows,
} from "./searchEfficiency";
const directory = Bun.argv[2],
  old = await import(directory + "/reference-d49/apps/four-shogi-study/src/search/runtime.ts");
const inputs = await Bun.file(directory + "/private-inputs/inputs.json").json(),
  input = inputs[5],
  source = efficiencySource(),
  fingerprint = JSON.stringify(source),
  begin = performance.now(),
  results = [];
for (let repeat = 0; repeat < 2; repeat++)
  for (const variant of repeat
    ? ["checks-on", "checks-off", "reference"]
    : ["reference", "checks-off", "checks-on"]) {
    if (JSON.stringify(efficiencySource()) !== fingerprint) throw Error("source changed");
    if (performance.now() - begin > 180000) throw Error("memory comparison time limit");
    const runtime = (
      variant === "reference" ? old.createStudySearchRuntime : createStudySearchRuntime
    )({ threads: 8, memoryMb: 8192, measureStages: true });
    try {
      const result = await measureEfficiencySearch(runtime, input.input, {
        strategy: "adaptive",
        timeBudgetMs: 20000,
        ...(variant === "reference" ? {} : { reuseChecks: variant === "checks-on" }),
      });
      results.push({
        id: input.id,
        strategy: "adaptive",
        budget: 20000,
        thermal: "cold",
        repeat,
        variant,
        result,
      });
      await Bun.write(
        directory + "/diagnostics/memory-ablation.json",
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
  directory + "/diagnostics/memory-ablation.json",
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
