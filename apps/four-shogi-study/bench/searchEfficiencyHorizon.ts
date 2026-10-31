import { fixedRootComparison } from "./tacticsImprovements";
import { restoreStudyPosition } from "../src/domain/study";
import { efficiencySource } from "./searchEfficiency";
import { tacticalCases, acceptsTactic } from "../../../packages/four-shogi/bench/tactics";
const directory = Bun.argv[2],
  oldStudy = await import(directory + "/reference-d49/apps/four-shogi-study/src/domain/study.ts"),
  oldBench = await import(
    directory + "/reference-d49/apps/four-shogi-study/bench/tacticsImprovements.ts"
  );
const baseline = (await Bun.file(directory + "/baseline/tactics.json").json()).results,
  optimized = (await Bun.file(directory + "/optimized/tactics.json").json()).results;
const begin = performance.now(),
  source = efficiencySource(),
  fingerprint = JSON.stringify(source),
  rows = [];
for (const newer of optimized) {
  const older = baseline.find((x: any) => x.id === newer.id && x.strategy === newer.strategy);
  if (newer.accepted === older.accepted) continue;
  const tactic = tacticalCases().find((x) => x.id === newer.id)!,
    positions = [
      await oldStudy.restoreStudyPosition(newer.input),
      await restoreStudyPosition(newer.input),
    ],
    actions = [older.action, newer.action];
  for (const depth of [...new Set([older.completedDepth, newer.completedDepth])]) {
    if (performance.now() - begin > 180000) throw Error("horizon total limit");
    const values = [];
    for (const variant of [0, 1]) {
      const result = await (variant ? fixedRootComparison : oldBench.fixedRootComparison)(
        positions[variant],
        actions,
        newer.strategy,
        depth,
        { phase: "deep", width: 2, ownWidth: 3 },
        { deadline: begin + 180000, maxWork: 2000000, taskMs: 15000 },
      );
      if (!result.complete) throw Error("horizon comparison incomplete");
      values[variant] = {
        selected: result.selected,
        rows: result.rows.map((r: any) => ({
          action: r.action,
          candidate: r.candidate,
          stats: r.stats,
        })),
      };
    }
    if (JSON.stringify(values[0]) !== JSON.stringify(values[1]))
      throw Error("same-depth output mismatch " + newer.id);
    rows.push({
      id: newer.id,
      strategy: newer.strategy,
      depth,
      roots: 2,
      allMatch: true,
      accepted: acceptsTactic(tactic, values[1].selected.action),
      selected: values[1].selected.action,
      scope: "two observed recommendation roots; controlled comparison, not global bestness proof",
    });
    await Bun.write(
      directory + "/diagnostics/horizon-validation.json",
      JSON.stringify({ source, complete: false, rows }) + "\n",
    );
  }
}
await Bun.write(
  directory + "/diagnostics/horizon-validation.json",
  JSON.stringify({
    source,
    sourceUnchanged: JSON.stringify(efficiencySource()) === fingerprint,
    complete: true,
    durationMs: performance.now() - begin,
    rows,
  }) + "\n",
);
console.log(JSON.stringify({ complete: true, rows: rows.length }));
