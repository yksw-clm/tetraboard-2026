import { expect, test } from "bun:test";
import { tacticalCases, acceptsTactic } from "../../../packages/four-shogi/bench/tactics";
import {
  getAnalysisLegalActions,
  advanceAnalysisPosition,
} from "../../../packages/four-shogi/src/analysis";
import { fixedRootComparison } from "../bench/tacticsImprovements";
import { refinementVarianceIds } from "../bench/tacticalRefinements";
import { tacticInput } from "../bench/tacticsDiagnostics";
import { restoreStudyPosition } from "../src/domain/study";
import { createStudyRootSearch } from "../../../packages/four-shogi/src/studySearch";
import { drainTask } from "../bench/tacticsDiagnostics";
import { getLegalMoves } from "../../../packages/four-shogi/src/transition";
import { priority } from "../../../packages/four-shogi/src/cpuSearch";
import {
  studyQuiescenceReason,
  selectStudyQuiescenceMoves,
} from "../../../packages/four-shogi/src/studyTacticalSelection";

test("追加の時間変動検査は改善方式から新たに不一致となった展開を保持する", () => {
  const ids = refinementVarianceIds([
    { id: "extra-tactic", strategy: "dual", accepted: true },
    { id: "extra-tactic", strategy: "dual-refined", accepted: false },
    { id: "already-failed", strategy: "dual", accepted: false },
    { id: "already-failed", strategy: "dual-refined", accepted: false },
  ]);
  expect(ids).toContain("extra-tactic");
  expect(ids).not.toContain("already-failed");
  expect(ids).toContain("inactive-rook-false-north");
  expect(ids).toContain("poisoned-gold-true-east");
});

test("選択延長は残予算0/1/2と通常深さを区別する", async () => {
  const tactic = tacticalCases().find((t) => t.id === "inactive-rook-false-north")!;
  const position = await restoreStudyPosition(tacticInput(tactic.state));
  const index = getAnalysisLegalActions(position).findIndex((action) =>
    acceptsTactic(tactic, action),
  );
  for (const extensions of [0, 1, 2]) {
    const search = createStudyRootSearch(position, { strategy: "dual-quiescent", extensions });
    try {
      expect(drainTask(search, performance.now() + 5000, true).complete).toBe(true);
      search.startTask(index, 9, false, { phase: "deep", width: 2, ownWidth: 3 });
      expect(drainTask(search, performance.now() + 5000).complete).toBe(true);
      const snapshot = search.snapshot();
      expect(snapshot.candidates[0].line.length).toBeLessThanOrEqual(9 + extensions);
      expect(snapshot.stats.completedDepth).toBe(9);
      if (extensions) {
        expect(snapshot.stats.extendedNodes).toBeGreaterThan(0);
      } else expect(snapshot.candidates[0].line).toHaveLength(9);
    } finally {
      search.dispose();
    }
  }
});

test("取り返しを延長対象に残し、実在する静かな合法手も含め最大3手を選ぶ", async () => {
  const tactic = tacticalCases().find((t) => t.id === "poisoned-gold-false-south")!;
  const position = await restoreStudyPosition(tacticInput(tactic.state));
  const action = getAnalysisLegalActions(position).find(
    (a) =>
      a.type === "movePiece" && !a.promote && position.state.board[a.to.y][a.to.x]?.kind === "gold",
  )!;
  const next = await advanceAnalysisPosition(position, {
    type: "action",
    side: position.state.turn!,
    action,
  });
  expect(studyQuiescenceReason(next.state)).toBe("recapture");
  const legal = getLegalMoves(next.state)
    .map((move, index) => ({ move, index, score: priority(move, next.state.turn!) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const before = structuredClone(next);
  const selected = selectStudyQuiescenceMoves(legal, next.state, false);
  expect(selected.length).toBeLessThanOrEqual(3);
  expect(selected.some((e) => e.move.captured?.kind === "rook")).toBe(true);
  expect(
    selected.some(
      (e) =>
        !e.move.captured &&
        e.score < 10000 &&
        !(e.move.action.type === "movePiece" && e.move.action.promote),
    ),
  ).toBe(true);
  for (const entry of selected)
    await advanceAnalysisPosition(next, {
      type: "action",
      side: next.state.turn!,
      action: entry.move.action,
    });
  expect(selectStudyQuiescenceMoves(legal, next.state, true)).toEqual(legal);
  expect(next).toEqual(before);
});

test("延長処理の予算切れを完成候補にせず、プロファイラは候補を変えない", async () => {
  const tactic = tacticalCases().find((t) => t.id === "inactive-rook-false-north")!;
  const position = await restoreStudyPosition(tacticInput(tactic.state));
  const samples: unknown[] = [];
  const searches = [
    createStudyRootSearch(position, { strategy: "dual-quiescent" }),
    createStudyRootSearch(
      position,
      { strategy: "dual-quiescent" },
      {
        profileExtension: (e) => {
          samples.push(e);
          Reflect.set(e, "selectedMoves", 999);
        },
      },
    ),
  ];
  try {
    for (const search of searches) {
      drainTask(search, performance.now() + 5000, true);
      search.startTask(5, 6, false, { phase: "deep", width: 2, ownWidth: 3 });
      expect(drainTask(search, performance.now() + 5000, false, 1).complete).toBe(false);
      expect(search.snapshot().candidates).toHaveLength(0);
      expect(search.snapshot().done).toBe(false);
      expect(drainTask(search, performance.now() + 5000).complete).toBe(true);
    }
    expect(samples.length).toBeGreaterThan(0);
    expect(searches[0].snapshot().candidates).toEqual(searches[1].snapshot().candidates);
    expect(searches[0].snapshot().stats).toEqual(searches[1].snapshot().stats);
  } finally {
    searches.forEach((s) => s.dispose());
  }
});

test("王手中は静かな合駒を含む全合法回避手を選別で落とさない", async () => {
  const tactic = tacticalCases().find((t) => t.id === "forced-block-false-south")!;
  const position = await restoreStudyPosition(tacticInput(tactic.state));
  expect(studyQuiescenceReason(position.state)).toBe("check");
  const legal = getLegalMoves(position.state).map((move, index) => ({
    move,
    index,
    score: priority(move, position.state.turn!),
  }));
  expect(legal.some((e) => e.move.action.type === "dropPiece")).toBe(true);
  expect(selectStudyQuiescenceMoves(legal, position.state, true)).toEqual(legal);
});

test("選択延長0は旧v6の候補・PV・workと一致する", async () => {
  const tactic = tacticalCases().find((t) => t.id === "inactive-rook-false-north")!;
  const position = await restoreStudyPosition(tacticInput(tactic.state));
  const searches = (["dual", "dual-quiescent"] as const).map((strategy) =>
    createStudyRootSearch(position, { strategy, extensions: 0 }),
  );
  try {
    for (const search of searches) {
      drainTask(search, performance.now() + 5000, true);
      search.startTask(5, 6, false, { phase: "deep", width: 2, ownWidth: 3 });
      expect(drainTask(search, performance.now() + 5000).complete).toBe(true);
    }
    expect(searches[0].snapshot().candidates).toEqual(searches[1].snapshot().candidates);
    expect(searches[0].snapshot().stats).toEqual(searches[1].snapshot().stats);
  } finally {
    searches.forEach((s) => s.dispose());
  }
});

for (const id of [
  "inactive-rook-false-north",
  "inactive-rook-false-south",
  "inactive-rook-false-east",
  "inactive-rook-true-south",
  "inactive-rook-true-east",
])
  test(`異なる王手方向を残し固定深さ9の飛車取りを維持する: ${id}`, async () => {
    const tactic = tacticalCases().find((t) => t.id === id)!;
    const position = await restoreStudyPosition(tacticInput(tactic.state));
    const actions = getAnalysisLegalActions(position);
    const roots = id.endsWith("north") ? [actions[0], actions[1], actions[5]] : actions;
    const result = await fixedRootComparison(
      position,
      roots,
      "dual-continuations",
      9,
      { phase: "deep", width: 2, ownWidth: 3 },
      { deadline: performance.now() + 30_000, taskMs: 10_000, maxWork: 2_000_000 },
    );
    expect(result.complete).toBe(true);
    expect(acceptsTactic(tactic, result.selected!.action)).toBe(true);
  }, 40_000);
