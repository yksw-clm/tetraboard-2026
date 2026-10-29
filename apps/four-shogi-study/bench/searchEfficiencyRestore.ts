import { efficiencySource } from "./searchEfficiency";
import { restoreStudyPosition } from "../src/domain/study";
const directory = Bun.argv[2];
if (!directory) throw Error("Git管理外の測定ディレクトリを指定してください");
const old = await import(directory + "/reference-d49/apps/four-shogi-study/src/domain/study.ts");
const inputs = await Bun.file(directory + "/private-inputs/inputs.json").json();
const rows = [],
  begin = performance.now(),
  source = efficiencySource();
for (const row of inputs) {
  await old.restoreStudyPosition(row.input);
  await restoreStudyPosition(row.input);
  for (let repeat = 0; repeat < 5; repeat++) {
    const values = [];
    for (const variant of repeat % 2 ? [1, 0] : [0, 1]) {
      const t = performance.now();
      const position = await (variant ? restoreStudyPosition : old.restoreStudyPosition)(row.input);
      values[variant] = { elapsedMs: performance.now() - t, hash: position.stateHash };
    }
    if (values[0].hash !== values[1].hash) throw Error("restore mismatch");
    rows.push({
      id: row.id,
      repeat,
      referenceMs: values[0].elapsedMs,
      optimizedMs: values[1].elapsedMs,
      allMatch: true,
      speedRatio: values[0].elapsedMs / values[1].elapsedMs,
    });
  }
}
await Bun.write(
  directory + "/diagnostics/restore-fixed-speed.json",
  JSON.stringify({
    source,
    sourceUnchanged: JSON.stringify(source) === JSON.stringify(efficiencySource()),
    complete: true,
    durationMs: performance.now() - begin,
    rows,
  }) + "\n",
);
console.log(JSON.stringify({ rows: rows.length, complete: true }));
