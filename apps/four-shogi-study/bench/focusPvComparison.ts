import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { restoreAnalysisPosition, advanceAnalysisPosition } from "@tetraboard/four-shogi/analysis";
import { createStudyRootSearch, selectStudyRootIndices } from "@tetraboard/four-shogi/study-search";
import { createFocusHints, prioritizeFocusRoots } from "../src/search/focusContinuation";
import { createStudySearchRuntime, type StudySearchSnapshot } from "../src/search/runtime";
import { guardBenchIdentity } from "./lethalGuardBench";
import { validateGuardCandidate } from "./lethalGuardValidation";
const root = Bun.argv[2];
if (!root) throw Error("root required");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const base = [
  ...readFileSync(join(root, "baseline/results.jsonl"), "utf8").trim().split("\n"),
  ...readFileSync(join(root, "baseline/extended-results.jsonl"), "utf8").trim().split("\n"),
]
  .map((x) => JSON.parse(x))
  .filter((x) => x.repeat === 0);
const output = join(root, "performance/pv.jsonl");
if (existsSync(output)) throw Error("previous measurement preserved");
let tested = 0;
for (const saved of base) {
  const input = read(join(root, "inputs", saved.id + ".json"));
  let source = await restoreAnalysisPosition(input.replay);
  for (const step of saved.snapshot.focus.prefix)
    source = await advanceAnalysisPosition(source, {
      type: "action",
      side: step.side,
      action: step.action,
    });
  let target = source;
  let steps = 0;
  for (const step of saved.snapshot.candidates[0].line) {
    if (steps > 0 && target.state.turn === input.focus) break;
    target = await advanceAnalysisPosition(target, {
      type: "action",
      side: step.side,
      action: step.action,
    });
    steps++;
  }
  const id = { scope: input.id, side: input.focus, conditions: "same P05 width6/root24/ext2" };
  const hints = createFocusHints();
  await hints.offer(source, id, saved.snapshot.candidates);
  const hint = hints.get(target, id);
  if (!hint || target.state.turn !== id.side) {
    appendFileSync(
      join(root, "performance/pv-ineligible.jsonl"),
      JSON.stringify({
        id: input.id,
        reason: "completed PV contains no legal next-own-turn hint",
      }) + "\n",
    );
    continue;
  }
  const targetInput = {
    origin: { kind: "replay" as const, replay: input.replay },
    events: [
      ...saved.snapshot.focus.prefix,
      ...saved.snapshot.candidates[0].line.slice(0, steps),
    ].map((s) => ({ type: "action" as const, side: s.side, action: s.action })),
  };
  for (const mode of ["BASE", "PV"] as const) {
    for (const limit of ["depth", "work"] as const) {
      const search = createStudyRootSearch(target, { strategy: "dual-continuations", maxDepth: 3 });
      const started = performance.now();
      const completed = [];
      try {
        while (search.snapshot().depth < 1 && !search.step()) {}
        const shallow = search.snapshot();
        let indices = selectStudyRootIndices(shallow.candidates, target.state.turn!, 24);
        if (mode === "PV") indices = prioritizeFocusRoots(indices, shallow.candidates, hint.action);
        for (const index of indices) {
          if (limit === "work" && search.work >= 20000) break;
          search.startTask(index, 3);
          let done = false;
          while (!(done = search.step())) {
            if (limit === "work" && search.work >= 20000) break;
            if (search.work > 2000000 || performance.now() - started > 20000)
              throw Error("fixed comparison limit");
          }
          if (done) {
            const c = search.snapshot().candidates[0];
            await validateGuardCandidate(target, c);
            completed.push(c);
          } else break;
        }
        appendFileSync(
          output,
          JSON.stringify({
            source: guardBenchIdentity(),
            id: input.id,
            mode,
            kind: limit,
            scope: "single-thread direct API fixed root task ordering",
            elapsedMs: performance.now() - started,
            work: search.work,
            cache: search.snapshot().performance,
            candidates: completed,
            allRootsComplete: completed.length === indices.length,
            rootSet: indices,
          }) + "\n",
        );
      } finally {
        search.dispose();
      }
    }
    const runtime = createStudySearchRuntime({
      threads: 4,
      memoryMb: 4096,
      taskPartition: "root",
      measureStages: true,
      ...(mode === "PV" ? { rootOrderHint: () => hint.action } : {}),
    });
    const started = performance.now();
    let first: number | null = null;
    try {
      const final = await new Promise<StudySearchSnapshot>((resolve, reject) => {
        void runtime
          .start(targetInput, { strategy: "dual-continuations", timeBudgetMs: 1000 }, (s) => {
            if (s.completedDepth > 0 && first === null) first = performance.now() - started;
            if (s.status === "error") reject(Error(s.reason ?? "error"));
            if (s.status === "completed") resolve(s);
          })
          .catch(reject);
      });
      for (const c of final.candidates) await validateGuardCandidate(target, c);
      appendFileSync(
        output,
        JSON.stringify({
          source: guardBenchIdentity(),
          id: input.id,
          mode,
          kind: "time",
          budgetMs: 1000,
          responseMs: performance.now() - started,
          firstCompletedMs: first,
          snapshot: final,
        }) + "\n",
      );
    } finally {
      await runtime.close();
    }
  }
  tested++;
  console.log(JSON.stringify({ case: input.id, tested }));
  if (tested === 8) break;
}
writeFileSync(
  join(root, "performance/pv-complete.json"),
  JSON.stringify({
    tested,
    complete: true,
    source: guardBenchIdentity(),
    endedAt: new Date().toISOString(),
  }) + "\n",
);
