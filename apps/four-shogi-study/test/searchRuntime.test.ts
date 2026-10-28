import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStudySearchRuntime, type StudySearchSnapshot } from "../src/search/runtime";
import type { StudyPositionInput } from "../src/shared/model";
import type { StudyCandidate } from "@tetraboard/four-shogi/study-search";

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
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function until(
  read: () => StudySearchSnapshot | null,
  predicate: (value: StudySearchSnapshot) => boolean,
) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const value = read();
    if (value && predicate(value)) return value;
    await Bun.sleep(10);
  }
  throw new Error("探索が指定した状態になりませんでした");
}
async function workerFixture(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "study-runtime-"));
  directories.push(directory);
  const pidPath = join(directory, "pid.json");
  const workerPath = join(directory, "worker.ts");
  await writeFile(
    workerPath,
    `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify(process.pid));
    ${body}
  `,
  );
  return {
    workerScript: pathToFileURL(workerPath),
    pid: async () => JSON.parse(await readFile(pidPath, "utf8")) as number,
  };
}
function expectExited(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow();
}
async function untilExited(pid: number) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("探索プロセスが終了しませんでした");
}

test("実Bunプロセスを並列化しても同じ深さの候補と4人分の読み筋を返す", async () => {
  const results: StudySearchSnapshot[] = [];
  for (const threads of [1, 4]) {
    const runtime = createStudySearchRuntime({ threads });
    try {
      const id = await runtime.start(input, {
        timeBudgetMs: null,
        maxDepth: 2,
        extensions: 0,
        width: 3,
        rootWidth: 6,
        dangerWork: 16,
      });
      results.push(
        await until(
          () => runtime.get(id),
          (value) => value.status === "completed",
        ),
      );
    } finally {
      await runtime.close();
    }
  }
  expect(results[0].completedDepth).toBe(2);
  expect(results[1].candidates).toEqual(results[0].candidates);
  expect(results[1].stateHash).toBe(results[0].stateHash);
  expect(results[1].recommendedAction).toEqual(results[0].recommendedAction);
}, 20000);

test("動的割当は空いたプロセスへ次の根を渡し、途中の深さを完成比較へ混ぜない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "study-dynamic-"));
  directories.push(directory);
  const trace = join(directory, "tasks.jsonl");
  const workerPath = join(directory, "worker.ts");
  const engine = new URL("../../../packages/four-shogi/src/studySearch.ts", import.meta.url).href;
  const restore = new URL("../src/domain/study.ts", import.meta.url).href;
  await writeFile(
    workerPath,
    `
    import { appendFileSync } from "node:fs";
    import { createStudyRootSearch } from ${JSON.stringify(engine)};
    import { restoreStudyPosition } from ${JSON.stringify(restore)};
    let search, id, lane;
    const send = (taskId) => {
      const snapshot = search.snapshot();
      if (taskId !== undefined) for (const candidate of snapshot.candidates) candidate.study.material.lineDelta = 999;
      process.send({ type: "progress", id, snapshot, memoryBytes: 1, barrier: true, ...(taskId === undefined ? {} : { taskId }) });
    };
    process.on("message", async (message) => {
      if (message.type === "close") process.exit(0);
      if (message.type === "start") {
        id = message.id; lane = message.options.lane;
        search = createStudyRootSearch(await restoreStudyPosition(message.input), message.options);
        while (search.depth < 1) search.step(); send();
      } else if (message.type === "task") {
        appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ lane, index: message.index }) + "\\n");
        search.startTask(message.index, message.depth, false);
        while (!search.step()) {}
        setTimeout(() => { send(message.taskId); setTimeout(() => send(message.taskId), 1); }, lane === 0 ? 180 : 2);
      }
    });
    process.send({ type: "ready" });
  `,
  );
  const runtime = createStudySearchRuntime({
    threads: 2,
    workerScript: pathToFileURL(workerPath),
    scheduling: "dynamic",
  });
  const snapshots: StudySearchSnapshot[] = [];
  try {
    const id = await runtime.start(
      input,
      { timeBudgetMs: null, maxDepth: 2, extensions: 0, dangerWork: 0 },
      (value) => snapshots.push(value),
    );
    const result = await until(
      () => runtime.get(id),
      (value) => value.status === "completed",
    );
    expect(result.completedDepth).toBe(2);
    expect(
      snapshots.every((value) =>
        value.candidates.every((candidate) => candidate.completedDepth === value.completedDepth),
      ),
    ).toBe(true);
    expect(
      snapshots
        .filter((value) => value.completedDepth === 1)
        .every((value) =>
          value.candidates.every(
            (candidate) => (candidate as StudyCandidate).study.material.lineDelta === 0,
          ),
        ),
    ).toBe(true);
    const tasks = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { lane: number; index: number });
    expect(new Set(tasks.map((entry) => entry.index)).size).toBe(tasks.length);
    expect(tasks.filter((entry) => entry.lane === 1).length).toBeGreaterThan(
      tasks.filter((entry) => entry.lane === 0).length,
    );
  } finally {
    await runtime.close();
  }
});

test("期限結果は一度だけ通知し、継続・一時停止・取消と再解析を行える", async () => {
  const runtime = createStudySearchRuntime({ threads: 2 });
  let completions = 0;
  try {
    const id = await runtime.start(input, { timeBudgetMs: 200 }, (value) => {
      if (value.status === "completed") completions++;
    });
    const timed = await until(
      () => runtime.get(id),
      (value) => value.status === "completed",
    );
    expect(timed.reason).toBe("deadline");
    expect(timed.recommendedAction).not.toBeNull();
    await Bun.sleep(30);
    expect(completions).toBe(1);
    await runtime.resume(id);
    const resumed = await until(
      () => runtime.get(id),
      (value) => value.status === "running" && value.work > timed.work,
    );
    expect(resumed.completedDepth).toBeGreaterThanOrEqual(timed.completedDepth);
    await runtime.pause(id);
    const elapsed = runtime.get(id)!.elapsedMs;
    await Bun.sleep(20);
    expect(runtime.get(id)?.status).toBe("paused");
    expect(runtime.get(id)?.elapsedMs).toBe(elapsed);
    await runtime.resume(id);
    await runtime.cancel(id);
    expect(runtime.get(id)?.status).toBe("cancelled");
    const replacement = await runtime.start(input, {
      timeBudgetMs: null,
      maxDepth: 1,
      dangerWork: 0,
    });
    const finished = await until(
      () => runtime.get(replacement),
      (value) => value.status === "completed",
    );
    expect(finished.id).not.toBe(id);
    expect(runtime.get(id)?.status).toBe("cancelled");
  } finally {
    await runtime.close();
  }
}, 20000);

test("再解析には新しい予算とIDを使い、前の結果を混ぜない", async () => {
  const runtime = createStudySearchRuntime({ threads: 1 });
  const notifications: StudySearchSnapshot[] = [];
  try {
    const first = await runtime.start(input, { timeBudgetMs: 50 }, (value) =>
      notifications.push(value),
    );
    await until(
      () => runtime.get(first),
      (value) => value.status === "completed",
    );
    const count = notifications.length;
    const second = await runtime.start(input, { timeBudgetMs: 80 });
    const completed = await until(
      () => runtime.get(second),
      (value) => value.status === "completed",
    );
    expect(completed.id).not.toBe(first);
    expect(completed.reason).toBe("deadline");
    expect(completed.elapsedMs).toBeGreaterThanOrEqual(60);
    expect(notifications).toHaveLength(count);
    expect(runtime.get(first)?.id).toBe(first);
  } finally {
    await runtime.close();
  }
});

test("並行した開始は最後の要求だけを有効にする", async () => {
  const runtime = createStudySearchRuntime({ threads: 1 });
  try {
    const requests = await Promise.allSettled([
      runtime.start(input, { timeBudgetMs: null }),
      runtime.start(input, { timeBudgetMs: 20 }),
    ]);
    expect(requests[0].status).toBe("rejected");
    expect(requests[1].status).toBe("fulfilled");
    if (requests[1].status !== "fulfilled") throw requests[1].reason;
    const id = requests[1].value;
    const completed = await until(
      () => runtime.get(id),
      (value) => value.status === "completed",
    );
    expect(completed.reason).toBe("deadline");
  } finally {
    await runtime.close();
  }
});

test("起動期限に達した子プロセスを終了し、close後の開始を拒否する", async () => {
  const worker = await workerFixture("setInterval(() => {}, 1000);");
  const runtime = createStudySearchRuntime({
    threads: 1,
    workerScript: worker.workerScript,
    startupTimeoutMs: 300,
  });
  try {
    await expect(runtime.start(input, { timeBudgetMs: null })).rejects.toThrow(
      "起動がタイムアウト",
    );
    expectExited(await worker.pid());
  } finally {
    await runtime.close();
  }
  await expect(runtime.start(input, { timeBudgetMs: 1 })).rejects.toThrow("終了しています");
});

test("プロセス起動中に新しい解析を要求しても最後の要求を開始できる", async () => {
  const worker = await workerFixture(`
    process.on("message", () => {});
    setTimeout(() => process.send?.({ type: "ready" }), 100);
  `);
  const runtime = createStudySearchRuntime({ threads: 1, workerScript: worker.workerScript });
  try {
    const first = runtime.start(input, { timeBudgetMs: null });
    await Bun.sleep(30);
    const requests = await Promise.allSettled([first, runtime.start(input, { timeBudgetMs: 10 })]);
    expect(requests[0].status).toBe("rejected");
    expect(requests[1].status).toBe("fulfilled");
    if (requests[1].status !== "fulfilled") throw requests[1].reason;
    const id = requests[1].value;
    expect(
      (
        await until(
          () => runtime.get(id),
          (value) => value.status === "completed",
        )
      ).reason,
    ).toBe("deadline");
  } finally {
    await runtime.close();
  }
});

test("子プロセスの異常終了を探索失敗として通知する", async () => {
  const worker = await workerFixture(`
    process.on("message", (message) => { if (message.type === "start") process.exit(23); });
    process.send?.({ type: "ready" });
  `);
  const runtime = createStudySearchRuntime({ threads: 1, workerScript: worker.workerScript });
  try {
    const id = await runtime.start(input, { timeBudgetMs: null });
    const failed = await until(
      () => runtime.get(id),
      (value) => value.status === "error",
    );
    expect(failed.reason).toContain("プロセスが終了");
    expect(failed.completedDepth).toBe(0);
    expect(failed.candidates).toHaveLength(0);
    expectExited(await worker.pid());
  } finally {
    await runtime.close();
  }
});

test("メモリ超過で結果を確定して子プロセスを解放し、継続を拒否する", async () => {
  const studyPath = fileURLToPath(new URL("../src/domain/study.ts", import.meta.url));
  const searchPath = fileURLToPath(
    new URL("../../../packages/four-shogi/src/studySearch.ts", import.meta.url),
  );
  const worker = await workerFixture(`
    import { restoreStudyPosition } from ${JSON.stringify(studyPath)};
    import { createStudyRootSearch } from ${JSON.stringify(searchPath)};
    process.on("message", async (message) => {
      if (message.type !== "start") return;
      const search = createStudyRootSearch(await restoreStudyPosition(message.input), message.options);
      process.send?.({ type: "progress", id: message.id, snapshot: search.snapshot(), memoryBytes: 129 * 1024 * 1024, barrier: false });
    });
    process.send?.({ type: "ready" });
  `);
  const runtime = createStudySearchRuntime({
    threads: 1,
    memoryMb: 128,
    workerScript: worker.workerScript,
  });
  try {
    const id = await runtime.start(input, { timeBudgetMs: null });
    const stopped = await until(
      () => runtime.get(id),
      (value) => value.status === "completed",
    );
    expect(stopped.reason).toBe("memory_limit");
    expect(stopped.memoryBytes).toBe(129 * 1024 * 1024);
    await runtime.resume(id);
    expect(runtime.get(id)?.status).toBe("completed");
    await untilExited(await worker.pid());
    expectExited(await worker.pid());
  } finally {
    await runtime.close();
  }
});

test("取消は応答しない探索プロセスを終了し、未完成の評価を残さない", async () => {
  const worker = await workerFixture(`
    process.on("message", () => {});
    process.send?.({ type: "ready" });
  `);
  const runtime = createStudySearchRuntime({ threads: 1, workerScript: worker.workerScript });
  try {
    const id = await runtime.start(input, { timeBudgetMs: null });
    expect(runtime.get(id)?.recommendedAction).not.toBeNull();
    expect(runtime.get(id)?.evaluation).toBeNull();
    await runtime.cancel(id);
    expectExited(await worker.pid());
    expect(runtime.get(id)?.status).toBe("cancelled");
    expect(runtime.get(id)?.candidates).toEqual([]);
  } finally {
    await runtime.close();
  }
});

test("応答しない子プロセスもcloseで強制終了する", async () => {
  const worker = await workerFixture(`
    process.on("message", () => {});
    process.send?.({ type: "ready" });
  `);
  const runtime = createStudySearchRuntime({
    threads: 1,
    workerScript: worker.workerScript,
    shutdownTimeoutMs: 25,
  });
  const id = await runtime.start(input, { timeBudgetMs: null });
  await runtime.close();
  expectExited(await worker.pid());
  expect(runtime.get(id)?.status).toBe("cancelled");
  expect(runtime.get(id)?.reason).toBe("closed");
  await runtime.close();
});
