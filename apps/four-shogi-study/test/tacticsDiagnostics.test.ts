import { expect, test } from "bun:test";
import {
  DiagnosticLog,
  replayWorker,
  tacticInput,
  digest,
  drainTask,
} from "../bench/tacticsDiagnostics";
import { tacticalCases } from "../../../packages/four-shogi/bench/tactics";
import {
  createStudySearchRuntime,
  type StudyRuntimeTraceEvent,
  type StudySearchSnapshot,
} from "../src/search/runtime";
import { restoreStudyPosition } from "../src/domain/study";
import { createStudyRootSearch } from "../../../packages/four-shogi/src/studySearch";

test("予算切れのタスクを完成候補として扱わず、完成枝キャッシュだけを無効にできる", async () => {
  const tactic = tacticalCases().find((t) => t.id === "inactive-rook-false-south")!;
  const position = await restoreStudyPosition(tacticInput(tactic.state));
  const bounded = createStudyRootSearch(position, { strategy: "dual", maxDepth: 3 });
  try {
    expect(drainTask(bounded, 0)).toMatchObject({ complete: false, reason: "time_limit", work: 0 });
    expect(drainTask(bounded, performance.now() + 5000, false, 1)).toMatchObject({
      complete: false,
      reason: "work_limit",
    });
    expect(bounded.snapshot().candidates).toHaveLength(0);
  } finally {
    bounded.dispose();
  }
  const cached = createStudyRootSearch(position, { strategy: "dual", maxDepth: 3, extensions: 0 });
  const uncached = createStudyRootSearch(
    position,
    { strategy: "dual", maxDepth: 3, extensions: 0 },
    { disableBranchCache: true },
  );
  try {
    for (const search of [cached, uncached]) {
      drainTask(search, performance.now() + 5000, true);
      for (let repeat = 0; repeat < 2; repeat++) {
        search.startTask(0, 3, false, { phase: "deep", width: 2, ownWidth: 3 });
        expect(drainTask(search, performance.now() + 5000).complete).toBe(true);
      }
    }
    expect(cached.snapshot().performance!.branchCacheHits).toBeGreaterThan(0);
    expect(uncached.snapshot().performance!.branchCacheHits).toBe(0);
    expect(uncached.snapshot().candidates[0].evaluation).toEqual(
      cached.snapshot().candidates[0].evaluation,
    );
    expect(uncached.snapshot().candidates[0].line).toEqual(cached.snapshot().candidates[0].line);
  } finally {
    cached.dispose();
    uncached.dispose();
  }
});

test("診断記録の容量超過は既存記録を保ち、省略を明示する", () => {
  const log = new DiagnosticLog<{ value: string }>(30);
  const value = { value: "a" };
  log.append(value);
  value.value = "changed";
  log.append({ value: "x".repeat(50) });
  log.append({ value: "b" });
  expect(log.entries).toEqual([{ value: "a" }]);
  expect(log.truncated).toBe(true);
  expect(log.omitted).toBe(2);
});

test("実Bun workerのタスク列を再生し、全完成タスクの候補とPVが一致する", async () => {
  const tactic = tacticalCases().find((t) => t.id === "inactive-rook-false-south")!;
  const events: StudyRuntimeTraceEvent[] = [];
  const runtime = createStudySearchRuntime({
    threads: 2,
    observeDiagnostic: (event) => events.push(event),
  });
  try {
    let finish!: (value: StudySearchSnapshot) => void;
    const done = new Promise<StudySearchSnapshot>((resolve) => {
      finish = resolve;
    });
    await runtime.start(
      tacticInput(tactic.state),
      { strategy: "dual", broadDepth: 2, maxDepth: 3, extensions: 0, timeBudgetMs: null },
      (value) => {
        if (value.status === "completed" || value.status === "error") finish(value);
      },
    );
    const completed = await done;
    expect(completed.status).toBe("completed");
    const before = digest(events);
    for (const worker of [0, 1]) {
      const result = await replayWorker(events, worker, performance.now() + 5000);
      expect(result.complete).toBe(true);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.every((task) => task.matches)).toBe(true);
    }
    expect(digest(events)).toBe(before);
    expect(
      events.some((event) => event.type === "publication" && event.published && event.depth === 3),
    ).toBe(true);
  } finally {
    await runtime.close();
  }
});
