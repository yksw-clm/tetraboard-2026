import { expect, test } from "bun:test";
import { createStudySearchRuntime, type StudySearchSnapshot } from "../src/search/runtime";
import { parallelTrial } from "../bench/parallelSearch";
import type { StudyPositionInput } from "../src/shared/model";
const input: StudyPositionInput = {
  origin: {
    kind: "replay",
    replay: {
      schemaVersion: 1,
      rulesVersion: 1,
      ruleProfileId: "tetraboard-four-shogi-singles-v1",
      initial: {
        mode: "singles",
        players: { south: "s", west: "w", north: "n", east: "e" },
        threePlayerAttackProhibited: false,
      },
      events: [],
    },
  },
  events: [],
};
test("実workerへ応手を分配し、完成根だけを同深さで公開する", async () => {
  const results: StudySearchSnapshot[] = [],
    commands = new Set<string>();
  for (const taskPartition of ["root", "replies"] as const) {
    const runtime = createStudySearchRuntime({
      threads: 4,
      taskPartition,
      measureStages: true,
      observeDiagnostic: (e) => {
        if (e.type === "command" && taskPartition === "replies") commands.add(e.command.type);
      },
    });
    try {
      results.push(
        (
          await parallelTrial(runtime, input, {
            strategy: "dual-continuations",
            timeBudgetMs: 10000,
            maxDepth: 6,
            broadDepth: 2,
            width: 2,
            rootWidth: 5,
            extensions: 0,
            dangerWork: 0,
            cacheSize: 0,
          })
        ).snapshot,
      );
    } finally {
      await runtime.close();
    }
  }
  expect(commands.has("subtree")).toBe(true);
  expect(commands.has("finish")).toBe(true);
  expect(results[1].completedDepth).toBe(6);
  expect(results[1].performance?.completedIterationWork ?? 0).toBeGreaterThan(0);
  for (const s of results) {
    const p = s.performance!;
    expect(s.work).toBe(
      (p.preparationWork ?? 0) +
        (p.rootSetupWork ?? 0) +
        p.immediateWork +
        p.materialWork +
        (p.completedIterationWork ?? 0),
    );
  }
  expect(results[1].recommendedAction).toEqual(results[0].recommendedAction);
  expect(results[1].candidates).toEqual(results[0].candidates);
  expect(results[1].work).toBe(results[0].work);
  expect(results[1].nodes).toBe(results[0].nodes);
  expect(results[1].timing!.subtreeTasksAssigned).toBeGreaterThan(0);
  expect(results[1].timing!.subtreeTasksCompleted).toBe(results[1].timing!.subtreeTasksAssigned);
  expect(results[1].timing!.pendingRoots).toBe(0);
  expect(results[1].diagnostics.searchVersion).toBe("local-root-maxn-v6-p0-5-p1-3-replies");
}, 20000);

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
async function wrapper(body: string, run: (url: URL) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "study-partitions-"));
  try {
    const path = join(directory, "worker.ts");
    await writeFile(
      path,
      `const original=process.send.bind(process);${body}\nawait import(${JSON.stringify(new URL("../src/search/worker.ts", import.meta.url).href)});`,
    );
    await run(pathToFileURL(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function until(
  read: () => StudySearchSnapshot | null,
  accept: (s: StudySearchSnapshot) => boolean,
) {
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    const s = read();
    if (s && accept(s)) return s;
    await Bun.sleep(5);
  }
  throw Error("探索状態の待機上限です");
}
const options = {
  strategy: "dual-continuations" as const,
  timeBudgetMs: null,
  maxDepth: 6,
  broadDepth: 2,
  width: 2,
  rootWidth: 5,
  extensions: 0,
  dangerWork: 0,
  cacheSize: 0,
};

test("単一workerと非対応方式は根分配を維持し、既定v5を変更しない", async () => {
  for (const strategy of ["adaptive", "dual-continuations", "dual-quiescent"] as const) {
    const commands = new Set<string>(),
      runtime = createStudySearchRuntime({
        threads: 1,
        taskPartition: "replies",
        observeDiagnostic: (e) => {
          if (e.type === "command") commands.add(e.command.type);
        },
      });
    try {
      const result = await parallelTrial(runtime, input, {
        ...options,
        strategy,
        maxDepth: 3,
        timeBudgetMs: 5000,
      });
      expect(result.snapshot.completedDepth).toBe(3);
      expect(commands.has("subtree")).toBe(false);
      if (strategy === "adaptive")
        expect(result.snapshot.diagnostics.searchVersion).toBe("local-root-maxn-v5");
    } finally {
      await runtime.close();
    }
  }
});

test("重複・古いtaskIdを拒否し、子の待機中に停止・再開・取消・新規解析できる", async () => {
  await wrapper(
    `process.send=(m)=>{if(m.taskId!==undefined){original({...m,taskId:m.taskId+100000});setTimeout(()=>original(m),15);}return original(m);};`,
    async (workerScript) => {
      let action: "pause" | "cancel" | null = "pause";
      const runtime = createStudySearchRuntime({
        threads: 4,
        workerScript,
        scheduling: "dynamic",
        taskPartition: "replies",
        measureStages: true,
        observeDiagnostic: (e) => {
          if (e.type === "command" && e.command.type === "subtree" && action) {
            const selected = action;
            action = null;
            const id = e.command.id;
            queueMicrotask(() => void runtime[selected](id));
          }
        },
      });
      try {
        const id = await runtime.start(input, options);
        const paused = await until(
          () => runtime.get(id),
          (s) => s.status === "paused",
        );
        expect(paused.timing!.pendingRoots).toBeGreaterThan(0);
        expect(paused.candidates.every((c) => c.completedDepth === paused.completedDepth)).toBe(
          true,
        );
        await runtime.resume(id);
        const result = await until(
          () => runtime.get(id),
          (s) => s.status === "completed" || s.status === "error",
        );
        expect(result.reason).toBe("max_depth");
        expect(result.completedDepth).toBe(6);
        expect(result.timing!.subtreeTasksCompleted).toBe(result.timing!.subtreeTasksAssigned);
        action = "cancel";
        const cancelled = await runtime.start(input, options);
        await until(
          () => runtime.get(cancelled),
          (s) => s.status === "cancelled",
        );
        const replacement = await runtime.start(input, { ...options, maxDepth: 2 });
        const final = await until(
          () => runtime.get(replacement),
          (s) => s.status === "completed" || s.status === "error",
        );
        expect(final.reason).toBe("max_depth");
        expect(final.completedDepth).toBe(2);
        expect(replacement).not.toBe(cancelled);
        expect(runtime.get(cancelled)!.status).toBe("cancelled");
        expect(final.candidates.every((c) => c.completedDepth === 2)).toBe(true);
      } finally {
        await runtime.close();
      }
    },
  );
}, 20000);

test("期限で保持した未完成の応手は完成深さへ混ぜず、継続時に再送して集約する", async () => {
  await wrapper(
    `let hold=true;process.on("message",m=>{if(m.type==="resume")hold=false;});process.send=(m)=>hold&&m.reply?.kind==="subtree"?true:original(m);`,
    async (workerScript) => {
      const runtime = createStudySearchRuntime({
        threads: 4,
        workerScript,
        scheduling: "dynamic",
        taskPartition: "replies",
        measureStages: true,
      });
      try {
        const id = await runtime.start(input, { ...options, timeBudgetMs: 5000 });
        const timed = await until(
          () => runtime.get(id),
          (s) => s.status === "completed" || s.status === "error",
        );
        expect(timed.reason).toBe("deadline");
        expect(timed.timing!.pendingRoots).toBeGreaterThan(0);
        expect(timed.timing!.pendingRoots!).toBeLessThanOrEqual(3);
        expect(timed.timing!.queuedSubtrees!).toBeLessThanOrEqual(48);
        expect(timed.completedDepth).toBe(3);
        expect(timed.candidates.every((c) => c.completedDepth === 3)).toBe(true);
        await runtime.resume(id);
        const final = await until(
          () => runtime.get(id),
          (s) => s.status === "completed" || s.status === "error",
        );
        expect(final.reason).toBe("max_depth");
        expect(final.completedDepth).toBe(6);
        expect(final.timing!.pendingRoots).toBe(0);
      } finally {
        await runtime.close();
      }
    },
  );
}, 20000);

for (const mode of ["memory", "exit"] as const)
  test(`分割中の${mode}で未完成根を公開せず、新しいIDで再試行できる`, async () => {
    await wrapper(
      `process.send=(m)=>{if(m.reply?.kind==="split"){${mode === "memory" ? "m.memoryBytes=9000*1024*1024;" : "process.exit(7);"}}return original(m);};`,
      async (workerScript) => {
        const runtime = createStudySearchRuntime({
          threads: 4,
          memoryMb: 8192,
          workerScript,
          scheduling: "dynamic",
          taskPartition: "replies",
          measureStages: true,
        });
        try {
          const id = await runtime.start(input, options);
          const failed = await until(
            () => runtime.get(id),
            (s) => s.status === "completed" || s.status === "error",
          );
          expect(mode === "memory" ? failed.reason : failed.status).toBe(
            mode === "memory" ? "memory_limit" : "error",
          );
          expect(failed.completedDepth).toBe(3);
          expect(failed.candidates.every((c) => c.completedDepth === 3)).toBe(true);
          const replacement = await runtime.start(input, { ...options, maxDepth: 2 });
          const final = await until(
            () => runtime.get(replacement),
            (s) => s.status === "completed" || s.status === "error",
          );
          expect(final.reason).toBe("max_depth");
          expect(final.completedDepth).toBe(2);
          expect(replacement).not.toBe(id);
        } finally {
          await runtime.close();
        }
      },
    );
  }, 20000);

test("フォーカスで投射した局面の文脈を応手分配にも渡す", async () => {
  const runtime = createStudySearchRuntime({
    threads: 4,
    taskPartition: "replies",
    measureStages: true,
  });
  try {
    const result = await parallelTrial(runtime, input, {
      ...options,
      timeBudgetMs: 10000,
      maxDepth: 5,
      focusSide: "west",
    });
    const s = result.snapshot;
    expect(s.reason).toBe("max_depth");
    expect(s.focus?.status).toBe("ready");
    expect(s.analysisStateHash).not.toBe(s.stateHash);
    expect(s.recommendedAction).toBeNull();
    expect(s.timing!.splitPlans).toBeGreaterThan(0);
    expect(s.candidates[0].line[0].side).toBe("west");
  } finally {
    await runtime.close();
  }
}, 20000);

test("測定のwork上限は取消として記録し、未完成探索を合格扱いしない", async () => {
  const runtime = createStudySearchRuntime({ threads: 2, taskPartition: "replies" });
  try {
    const result = await parallelTrial(runtime, input, { ...options, timeBudgetMs: 5000 }, 1);
    expect(result.limitReason).toBe("work_limit");
    expect(result.snapshot.status).toBe("cancelled");
    expect(result.snapshot.completedDepth).toBeLessThan(6);
  } finally {
    await runtime.close();
  }
});

test("担当変更後の未検査通知で、実施済み資産検査の打切り理由を上書きしない", async () => {
  await wrapper(
    `process.send=(m)=>{if(m.type==="progress"&&m.barrier&&m.snapshot.depth>=3)for(const c of m.snapshot.candidates)c.study.material={...c.study.material,complete:false,limit:"interrupted"};return original(m);};`,
    async (workerScript) => {
      const runtime = createStudySearchRuntime({
        threads: 4,
        workerScript,
        scheduling: "dynamic",
        taskPartition: "replies",
      });
      try {
        const result = await parallelTrial(runtime, input, { ...options, timeBudgetMs: 5000 });
        expect(result.snapshot.reason).toBe("max_depth");
        expect(result.snapshot.candidates.length).toBeGreaterThan(0);
        expect(
          result.snapshot.candidates.every(
            (c) =>
              (c as import("@tetraboard/four-shogi/study-search").StudyCandidate).study.material
                .limit === "work_limit",
          ),
        ).toBe(true);
        expect(
          result.snapshot.candidates.every(
            (c) =>
              !(c as import("@tetraboard/four-shogi/study-search").StudyCandidate).study.material
                .complete,
          ),
        ).toBe(true);
      } finally {
        await runtime.close();
      }
    },
  );
}, 20000);

test("保持枠を実workerへ渡し、通常の根分配と既定v5には縮小を適用しない", async () => {
  for (const [strategy, taskPartition, replyCacheBudget, bounded] of [
    ["dual-continuations", "replies", "roots", true],
    ["dual-continuations", "replies", "workers", false],
    ["dual-continuations", "root", "roots", false],
    ["adaptive", "replies", "roots", false],
  ] as const) {
    const limits: (number | undefined)[] = [];
    const runtime = createStudySearchRuntime({
      threads: 4,
      taskPartition,
      replyCacheBudget,
      measureStages: true,
      observeDiagnostic: (e) => {
        if (e.type === "command" && e.command.type === "start")
          limits.push(e.command.options.subtreeCacheLimit);
      },
    });
    try {
      const s = (
        await parallelTrial(runtime, input, {
          ...options,
          strategy,
          maxDepth: 4,
          timeBudgetMs: 5000,
          cacheSize: 64,
        })
      ).snapshot;
      expect(s.completedDepth).toBe(4);
      expect(limits).toEqual(Array(4).fill(bounded ? 48 : undefined));
      if (bounded) {
        expect(s.timing!.subtreeTasksAssigned).toBeGreaterThan(0);
        expect(s.performance!.contextCacheCapacity).toBeLessThan(256);
      } else expect(s.performance!.contextCacheCapacity).toBe(256);
      if (strategy === "adaptive") expect(s.performance!.checkCacheHits).toBe(0);
    } finally {
      await runtime.close();
    }
  }
}, 20000);
