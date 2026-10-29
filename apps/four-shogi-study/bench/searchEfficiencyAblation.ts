import { createStudySearchRuntime } from "../src/search/runtime";
import {
  measureEfficiencySearch,
  efficiencySource,
  verifyEfficiencyRows,
} from "./searchEfficiency";
// 4固定入力・2予算・各3回。重い測定は既存の主要測定と直列に実行します。
const directory = Bun.argv[2];
if (!directory) throw Error("Git管理外の測定ディレクトリを指定してください");
const inputs = await Bun.file(directory + "/private-inputs/inputs.json").json();
const source = efficiencySource(),
  fingerprint = JSON.stringify(source),
  begin = performance.now();
const results = [];
for (const budget of [500, 2000])
  for (const index of [0, 2, 5, 15])
    for (let repeat = 0; repeat < 3; repeat++)
      for (const strategy of ["dual-continuations", "dual-quiescent"] as const)
        for (const reuseWorkers of repeat % 2 ? [true, false] : [false, true]) {
          if (JSON.stringify(efficiencySource()) !== fingerprint) throw Error("source changed");
          if (performance.now() - begin > 240000) throw Error("pool ablation time limit");
          const runtime = createStudySearchRuntime({
            threads: 4,
            memoryMb: 8192,
            measureStages: true,
            reuseWorkers,
          });
          try {
            await measureEfficiencySearch(runtime, inputs[index].input, {
              strategy,
              timeBudgetMs: 100,
            });
            const result = await measureEfficiencySearch(runtime, inputs[index].input, {
              strategy,
              timeBudgetMs: budget,
            });
            results.push({
              id: inputs[index].id,
              strategy,
              budget,
              thermal: "warm",
              repeat,
              reuseWorkers,
              result,
            });
            await Bun.write(
              directory + "/diagnostics/pool-ablation.json",
              JSON.stringify({ source, complete: false, results }) + "\n",
            );
          } finally {
            await runtime.close();
          }
        }
const validation = await verifyEfficiencyRows(results, inputs);
await Bun.write(
  directory + "/diagnostics/pool-ablation.json",
  JSON.stringify({
    source,
    sourceUnchanged: JSON.stringify(efficiencySource()) === fingerprint,
    complete: true,
    durationMs: performance.now() - begin,
    validation,
    results,
  }) + "\n",
);
console.log(JSON.stringify({ rows: results.length, validation, complete: true }));
