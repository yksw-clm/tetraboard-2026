import { createStudySearchRuntime } from "../src/search/runtime";
import {
  measureEfficiencySearch,
  efficiencySource,
  efficiencyStrategies,
} from "./searchEfficiency";
const directory = Bun.argv[2],
  phase = Bun.argv[3] ?? "baseline";
const inputs = await Bun.file(directory + "/private-inputs/inputs.json").json();
const strategies = Bun.argv[4]?.split(",") ?? [...efficiencyStrategies];
if (strategies.some((s) => !efficiencyStrategies.includes(s as any)))
  throw Error("unknown strategy");
const source = efficiencySource(),
  fingerprint = JSON.stringify(source);
const results = [];
for (const budget of [500, 2000])
  for (const index of [0, 2, 5, 15])
    for (let repeat = 1; repeat <= 2; repeat++)
      for (let offset = 0; offset < 4; offset++) {
        if (JSON.stringify(efficiencySource()) !== fingerprint) throw Error("source changed");
        const strategy = efficiencyStrategies[(index + repeat + offset) % 4];
        if (!strategies.includes(strategy)) continue;
        const runtime = createStudySearchRuntime({
          threads: 4,
          memoryMb: 8192,
          measureStages: true,
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
          results.push({ id: inputs[index].id, strategy, budget, thermal: "warm", repeat, result });
          await Bun.write(
            directory + "/diagnostics/" + phase + "-short-repeats.json",
            JSON.stringify({ source, complete: false, results }) + "\n",
          );
        } finally {
          await runtime.close();
        }
      }
await Bun.write(
  directory + "/diagnostics/" + phase + "-short-repeats.json",
  JSON.stringify({
    source,
    sourceUnchanged: JSON.stringify(efficiencySource()) === fingerprint,
    complete: true,
    results,
  }) + "\n",
);
console.log(JSON.stringify({ rows: results.length, complete: true }));
