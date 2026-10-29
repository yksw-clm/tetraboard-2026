import { expect, test } from "bun:test";
import { tacticalCases } from "../../../packages/four-shogi/bench/tactics";
import { createStudyRootSearch } from "../../../packages/four-shogi/src/studySearch";
import { tacticInput, drainTask } from "../bench/tacticsDiagnostics";
import { restoreStudyPosition } from "../src/domain/study";
import { createStudySearchRuntime } from "../src/search/runtime";
import { measureEfficiencySearch } from "../bench/searchEfficiency";

test("詳細計測の有無で完成候補・PV・評価・workを変えない", async () => {
  const tactic = tacticalCases().find((t) => t.id === "inactive-rook-false-north")!;
  const position = await restoreStudyPosition(tacticInput(tactic.state));
  const snapshots = [];
  for (const measureDetails of [false, true]) {
    const search = createStudyRootSearch(position, {
      strategy: "dual-continuations",
      measureDetails,
    });
    try {
      expect(drainTask(search, performance.now() + 5000, true).complete).toBe(true);
      search.startTask(5, 3, false, { phase: "deep", width: 2, ownWidth: 3 });
      expect(drainTask(search, performance.now() + 5000).complete).toBe(true);
      snapshots.push(search.snapshot());
    } finally {
      search.dispose();
    }
  }
  expect(snapshots[1].candidates).toEqual(snapshots[0].candidates);
  expect(snapshots[1].stats).toEqual(snapshots[0].stats);
  expect(snapshots[1].performance!.priorityCalls).toBeGreaterThan(0);
  expect(snapshots[1].performance!.priorityMs).toBeGreaterThanOrEqual(0);
  expect(snapshots[1].performance!.checkCalls).toBeGreaterThan(0);
  expect(snapshots[1].performance!.legalCalls).toBeGreaterThan(0);
});

test("実プロセスの初期化・完成深さ・deep開始を壁時計と分けて記録する", async () => {
  const tactic = tacticalCases().find((t) => t.id === "inactive-rook-false-north")!;
  const runtime = createStudySearchRuntime({ threads: 1, measureStages: true });
  try {
    const result = await measureEfficiencySearch(runtime, tacticInput(tactic.state), {
      strategy: "dual-continuations",
      maxDepth: 3,
      broadDepth: 2,
      rootWidth: 5,
      width: 1,
      dangerWork: 0,
      extensions: 0,
      timeBudgetMs: 10000,
    });
    expect(result.snapshot.completedDepth).toBe(3);
    expect(result.snapshot.timing!.depthOneMs).not.toBeNull();
    expect(result.snapshot.timing!.depthTwoMs).not.toBeNull();
    expect(result.snapshot.timing!.deepStartedMs).not.toBeNull();
    expect(result.snapshot.timing!.tasksCompleted).toBeGreaterThan(0);
    expect(result.snapshot.timing!.ipcCommands).toBeGreaterThan(0);
    expect(result.snapshot.timing!.ipcMessages).toBeGreaterThan(0);
    expect(result.responseMs).toBeGreaterThanOrEqual(result.snapshot.elapsedMs);
    expect(result.snapshot.timing!.workers[0]!.cpuMs).toBeGreaterThan(0);
    expect(result.snapshot.performance!.generatedMoves).toBeGreaterThan(0);
  } finally {
    await runtime.close();
  }
});

import { verifyEfficiencyRows } from "../bench/searchEfficiency";
test("PVの評価だけでなく着手メタデータも正本の再生と照合する", async () => {
  const tactic = tacticalCases().find((t) => t.id === "free-rook-false-north")!,
    input = tacticInput(tactic.state),
    runtime = createStudySearchRuntime({ threads: 1 });
  try {
    const result = await measureEfficiencySearch(runtime, input, {
      strategy: "dual-continuations",
      maxDepth: 2,
      broadDepth: 2,
      extensions: 0,
      dangerWork: 0,
      rootWidth: 5,
      width: 2,
      timeBudgetMs: 5000,
    });
    const row = { id: tactic.id, result };
    expect((await verifyEfficiencyRows([row], [{ id: tactic.id, input }])).allMatch).toBe(true);
    const snapshot = structuredClone(result.snapshot),
      candidate = snapshot.candidates[0];
    const corrupted = {
      ...candidate,
      line: candidate.line.map((step, i) =>
        i === 0
          ? {
              ...step,
              eliminations: [
                { side: "north" as const, reason: "left" as const, rank: 4, group: 1 },
              ],
            }
          : step,
      ),
    };
    await expect(
      verifyEfficiencyRows(
        [
          {
            id: tactic.id,
            result: { ...result, snapshot: { ...snapshot, candidates: [corrupted] } },
          },
        ],
        [{ id: tactic.id, input }],
      ),
    ).rejects.toThrow("PVメタデータ");
  } finally {
    await runtime.close();
  }
});
