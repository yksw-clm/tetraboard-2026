import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStudySearchRuntime, type StudySearchSnapshot } from "../src/search/runtime";
import { createGuardedStudySearchRuntime } from "../src/search/guardedRuntime";
import { tacticInput } from "../bench/tacticsDiagnostics";
import { fixture } from "../../../packages/four-shogi/bench/positionFixture";
import { restoreStudyPosition } from "../src/domain/study";
import { getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import { proveFiniteAction } from "../../../packages/four-shogi/src/finiteSurvival";

const input = () => tacticInput(fixture());

test("起動中に予算を使い切ったジョブは、追加の探索を始めず未完成を返す", async () => {
  const directory = await mkdtemp(join(tmpdir(), "study-deadline-ready-"));
  const file = join(directory, "worker.ts");
  await writeFile(
    file,
    `setTimeout(() => process.send?.({type:'ready'}), 50); process.on('message', m => { if (m.type === 'close') process.exit(0); });`,
  );
  const runtime = createStudySearchRuntime({ threads: 1, workerScript: pathToFileURL(file) });
  try {
    const id = await runtime.start(input(), { timeBudgetMs: 1 });
    const result = runtime.get(id)!;
    expect(result.status).toBe("completed");
    expect(result.reason).toBe("deadline");
    expect(result.completedDepth).toBe(0);
    expect(result.candidates).toEqual([]);
    expect(result.evaluation).toBeNull();
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("有限検査はtimerによる取消を受理し、完成証明へ変換しない", async () => {
  const position = await restoreStudyPosition(input());
  const action = getAnalysisLegalActions(position)[0];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 0);
  try {
    const proof = await proveFiniteAction(position, action, position.state.turn!, 4, {
      maxTransitions: 5000,
      maxMs: 1000,
      signal: controller.signal,
      yieldIntervalMs: 0,
    });
    expect(controller.signal.aborted).toBe(true);
    expect(proof.status).toBe("unknown");
    expect(proof.limit).toBe("cancelled");
  } finally {
    clearTimeout(timer);
  }
});

test("ガード例外は最後の完成比較を保持し、ガード完成とは区別する", async () => {
  const runtime = createGuardedStudySearchRuntime(
    { threads: 1, memoryMb: 512 },
    { mode: "experimental", budgetMs: 50, horizon: 5 },
  );
  let resolve!: (s: StudySearchSnapshot) => void;
  const done = new Promise<StudySearchSnapshot>((r) => {
    resolve = r;
  });
  try {
    await runtime.start(input(), { timeBudgetMs: 1000, maxDepth: 1 }, (s) => {
      if (s.status !== "running") resolve(s);
    });
    const result = await done;
    expect(result.status).toBe("completed");
    expect(result.reason).toBe("guard_error");
    expect(result.completedDepth).toBe(1);
    expect(result.recommendedAction).toEqual(result.candidates[0].action);
    expect(result.lethalGuard?.changed ?? false).toBe(false);
  } finally {
    await runtime.close();
  }
});
