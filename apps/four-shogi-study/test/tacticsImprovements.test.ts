import { expect, test } from "bun:test";
import { tacticalCases, acceptsTactic } from "../../../packages/four-shogi/bench/tactics";
import { getAnalysisLegalActions } from "../../../packages/four-shogi/src/analysis";
import {
  createStudyRootSearch,
  compareStudyCandidates,
  type StudyTraceEvent,
} from "../../../packages/four-shogi/src/studySearch";
import { restoreStudyPosition } from "../src/domain/study";
import { tacticInput, drainTask } from "../bench/tacticsDiagnostics";
import { fixedRootComparison } from "../bench/tacticsImprovements";

test("比較のwork予算が足りなければ完成推奨手を作らない", async () => {
  const tactic = tacticalCases().find((t) => t.id === "inactive-rook-false-south")!;
  const position = await restoreStudyPosition(tacticInput(tactic.state));
  const result = await fixedRootComparison(
    position,
    getAnalysisLegalActions(position).slice(0, 2),
    "dual-combined",
    9,
    { phase: "deep", width: 2, ownWidth: 3 },
    { deadline: performance.now() + 5000, taskMs: 5000, maxWork: 1 },
  );
  expect(result.complete).toBe(false);
  expect(result.selected).toBeNull();
});

test("自手番の成りを最大1手補い、静的上位K手を保持する", async () => {
  const tactic = tacticalCases().find((t) => t.id === "inactive-rook-false-south")!;
  const position = await restoreStudyPosition(tacticInput(tactic.state));
  const index = getAnalysisLegalActions(position).findIndex((action) =>
    acceptsTactic(tactic, action),
  );
  const events: StudyTraceEvent[] = [];
  const search = createStudyRootSearch(
    position,
    { strategy: "dual-promotions", extensions: 2 },
    { observe: (event) => events.push(event) },
  );
  try {
    expect(drainTask(search, performance.now() + 10_000, true).complete).toBe(true);
    search.startTask(index, 9, false, { phase: "deep", width: 2, ownWidth: 3 });
    expect(drainTask(search, performance.now() + 10_000).complete).toBe(true);
    const nodes = events.filter(
      (e): e is Extract<StudyTraceEvent, { type: "selection" }> =>
        e.type === "selection" && e.turn === position.state.turn && e.remaining > 1,
    );
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.some((node) => node.rows.some((row) => row.reason === "promotion_reserve"))).toBe(
      true,
    );
    for (const node of nodes) {
      const extra = node.rows.filter((row) => row.reason === "promotion_reserve");
      expect(extra.length).toBeLessThanOrEqual(1);
      expect(
        node.rows
          .filter((row) => row.staticRank !== null && row.staticRank <= 3)
          .every((row) => row.selected),
      ).toBe(true);
      expect(
        extra.every((row) => row.action.type === "movePiece" && row.action.promote && row.selected),
      ).toBe(true);
    }
  } finally {
    search.dispose();
  }
}, 30_000);

for (const restricted of [false, true])
  for (const side of ["south", "east"])
    test(`成り保持で既知の飛車取りを固定深さ9で再評価する: ${restricted}/${side}`, async () => {
      const tactic = tacticalCases().find((t) => t.id === `inactive-rook-${restricted}-${side}`)!;
      const position = await restoreStudyPosition(tacticInput(tactic.state));
      const actions = getAnalysisLegalActions(position);
      const search = createStudyRootSearch(position, {
        strategy: "dual-promotions",
        extensions: 2,
      });
      try {
        expect(drainTask(search, performance.now() + 10_000, true).complete).toBe(true);
        const roots = search
          .snapshot()
          .candidates.sort((a, b) => compareStudyCandidates(a, b, position.state.turn!))
          .slice(0, 3)
          .map((candidate) => candidate.rootIndex);
        const expected = actions.findIndex((action) => acceptsTactic(tactic, action));
        if (!roots.includes(expected)) roots.push(expected);
        const candidates = [];
        for (const root of roots) {
          search.startTask(root, 9, false, { phase: "deep", width: 2, ownWidth: 3 });
          expect(drainTask(search, performance.now() + 10_000).complete).toBe(true);
          candidates.push(search.snapshot().candidates[0]);
        }
        candidates.sort((a, b) => compareStudyCandidates(a, b, position.state.turn!));
        expect(acceptsTactic(tactic, candidates[0].action)).toBe(true);
      } finally {
        search.dispose();
      }
    }, 60_000);
