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

test("起動前に予算が終わった通常解析も、継続ではworkerを準備して探索できる", async () => {
  const runtime = createStudySearchRuntime({ threads: 1 });
  try {
    const id = await runtime.start(input(), { timeBudgetMs: 1, maxDepth: 1 });
    expect(runtime.get(id)?.completion?.normalResult).toBe("incomplete");
    await runtime.resume(id);
    const deadline = performance.now() + 2000;
    while (runtime.get(id)?.status === "running" && performance.now() < deadline)
      await Bun.sleep(5);
    expect(runtime.get(id)?.status).toBe("completed");
    expect(runtime.get(id)?.completedDepth).toBe(1);
  } finally {
    await runtime.close();
  }
});

test("置換前の起動期限は、新しいジョブが共有するworkerを終了しない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "study-deadline-replaced-"));
  const file = join(directory, "worker.ts");
  await writeFile(
    file,
    `await new Promise(resolve=>setTimeout(resolve,80));await import(${JSON.stringify(new URL("../src/search/worker.ts", import.meta.url).href)});`,
  );
  let second: Promise<string> | undefined;
  let replace = true;
  const runtime = createStudySearchRuntime({
    threads: 1,
    workerScript: pathToFileURL(file),
    scheduling: "dynamic",
    onPreparedPosition() {
      if (replace) {
        replace = false;
        second = Promise.resolve().then(() =>
          runtime.start(input(), { timeBudgetMs: 1000, maxDepth: 1 }),
        );
      }
    },
  });
  try {
    await runtime.start(input(), { timeBudgetMs: 30 }).catch(() => null);
    const id = await second!;
    const deadline = performance.now() + 2000;
    while (runtime.get(id)?.status === "running" && performance.now() < deadline)
      await Bun.sleep(5);
    expect(runtime.get(id)?.status).toBe("completed");
    expect(runtime.get(id)?.reason).toBe("max_depth");
    expect(runtime.get(id)?.completedDepth).toBe(1);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("readyを返さないworkerもジョブ予算で待機を打ち切り、未完成結果を返す", async () => {
  const directory = await mkdtemp(join(tmpdir(), "study-deadline-unready-"));
  const file = join(directory, "worker.ts");
  await writeFile(file, "process.on('message', m => { if(m.type === 'close') process.exit(0); });");
  const runtime = createStudySearchRuntime({
    threads: 1,
    workerScript: pathToFileURL(file),
    startupTimeoutMs: 500,
  });
  try {
    const result = await runtime.start(input(), { timeBudgetMs: 30 }).then(
      (id) => ({ snapshot: runtime.get(id), error: null }),
      (error) => ({ snapshot: null, error: String(error) }),
    );
    expect(result.error).toBeNull();
    expect(result.snapshot?.status).toBe("completed");
    expect(result.snapshot?.reason).toBe("deadline");
    expect(result.snapshot?.completion?.normalResult).toBe("incomplete");
    expect(result.snapshot?.candidates).toEqual([]);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
