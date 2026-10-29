import { expect, test } from "bun:test";
import { tacticalCases } from "../../../packages/four-shogi/bench/tactics";
import { tacticInput } from "../bench/tacticsDiagnostics";
import { measureEfficiencySearch } from "../bench/searchEfficiency";
import { createStudySearchRuntime, type StudyParallelEvent } from "../src/search/runtime";

test("並列計測は送受信量とタスク境界を記録し、完成候補と仕事量を変えない", async () => {
  const input = tacticInput(
    tacticalCases().find((t) => t.id === "inactive-rook-false-north")!.state,
  );
  const events: StudyParallelEvent[] = [],
    snapshots = [];
  for (const measured of [false, true]) {
    const runtime = createStudySearchRuntime({
      threads: 1,
      measureStages: true,
      ...(measured ? { observeParallel: (event: StudyParallelEvent) => events.push(event) } : {}),
    });
    try {
      snapshots.push(
        (
          await measureEfficiencySearch(runtime, input, {
            strategy: "dual-continuations",
            timeBudgetMs: 10000,
            maxDepth: 3,
            broadDepth: 2,
            width: 1,
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
  expect(snapshots[1].candidates).toEqual(snapshots[0].candidates);
  expect(snapshots[1].work).toBe(snapshots[0].work);
  expect(snapshots[1].nodes).toBe(snapshots[0].nodes);
  expect(events.filter((e) => e.type === "assigned").length).toBeGreaterThan(0);
  expect(events.some((e) => e.type === "ipc" && e.direction === "send" && e.jsonBytes > 0)).toBe(
    true,
  );
  // 未計測の受信経路ではfalseになることを、実装前の失敗として確認します。
  expect(events.some((e) => e.type === "ipc" && e.direction === "receive" && e.jsonBytes > 0)).toBe(
    true,
  );
  expect(events.some((e) => e.type === "worker" && e.barrier && e.activeMs > 0)).toBe(true);
});

import { createParallelRecorder } from "../bench/parallelTelemetry";
test("並列度は壁時計の区間積分で求め、CPU時間と区別する", () => {
  const meter = createParallelRecorder(2),
    id = "fixed";
  meter.observe({ type: "iteration", id, atMs: 0, depth: 4, phase: "deep", roots: 2 });
  for (const worker of [0, 1])
    meter.observe({
      type: "assigned",
      id,
      atMs: 0,
      worker,
      taskId: worker + 1,
      index: worker,
      depth: 4,
      phase: "deep",
    });
  for (const [worker, atMs, activeMs, cpuMs] of [
    [0, 50, 30, 40],
    [1, 100, 60, 80],
  ])
    meter.observe({
      type: "worker",
      id,
      atMs,
      worker,
      taskId: worker + 1,
      index: worker,
      depth: 4,
      phase: "deep",
      barrier: true,
      accepted: true,
      work: 10,
      nodes: 5,
      rss: 100,
      activeMs,
      cpuMs,
      restoreMs: 1,
      createMs: 1,
    });
  meter.observe({ type: "iterationEnd", id, atMs: 100, depth: 4, phase: "deep", roots: 2 });
  const summary = meter.summarize(id);
  expect(summary.phases.deep.averageConcurrent).toBe(1.5);
  expect(summary.phases.deep.peakConcurrent).toBe(2);
  expect(summary.phases.deep.sampledActiveShare).toBe(0.45);
  expect(summary.phases.deep.cpuMs).toBe(120);
  expect(summary.phases.deep.workers[0].assignedWaitMs).toBe(50);
  expect(summary.iterations[0].tailWaitMs).toBe(50);
});
