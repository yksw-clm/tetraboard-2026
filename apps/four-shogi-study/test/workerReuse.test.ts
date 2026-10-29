import { expect, test } from "bun:test";
import { tacticalCases } from "../../../packages/four-shogi/bench/tactics";
import { tacticInput } from "../bench/tacticsDiagnostics";
import { createStudySearchRuntime } from "../src/search/runtime";
import { measureEfficiencySearch } from "../bench/searchEfficiency";

test("プロセスだけを再利用し、別局面の結果やキャッシュを混用しない", async () => {
  let ready = 0;
  const runtime = createStudySearchRuntime({
    threads: 1,
    reuseWorkers: true,
    observeDiagnostic: (event) => {
      if (event.type === "message" && event.message.type === "ready") ready++;
    },
  });
  const fresh = createStudySearchRuntime({ threads: 1, reuseWorkers: false });
  const firstInput = tacticInput(
    tacticalCases().find((t) => t.id === "inactive-rook-false-north")!.state,
  );
  const secondInput = tacticInput(
    tacticalCases().find((t) => t.id === "poisoned-gold-true-east")!.state,
  );
  const options = {
    strategy: "dual-continuations" as const,
    timeBudgetMs: 10000,
    maxDepth: 3,
    rootWidth: 5,
    width: 1,
    extensions: 0,
    dangerWork: 0,
  };
  try {
    const first = await measureEfficiencySearch(runtime, firstInput, options);
    const second = await measureEfficiencySearch(runtime, secondInput, options);
    expect(ready).toBe(1);
    expect(second.snapshot.stateHash).not.toBe(first.snapshot.stateHash);
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    const control = await measureEfficiencySearch(fresh, secondInput, options);
    expect(second.snapshot.candidates).toEqual(control.snapshot.candidates);
    expect(second.snapshot.work).toBe(control.snapshot.work);
    await runtime.cancel(second.snapshot.id);
    await measureEfficiencySearch(runtime, firstInput, options);
    expect(ready).toBe(2);
  } finally {
    await runtime.close();
    await fresh.close();
  }
});
