import { expect, test } from "bun:test";
import { tacticalCases, acceptsTactic } from "../../../packages/four-shogi/bench/tactics";
import { getAnalysisLegalActions } from "../../../packages/four-shogi/src/analysis";
import { fixedRootComparison } from "../bench/tacticsImprovements";
import { tacticInput } from "../bench/tacticsDiagnostics";
import { restoreStudyPosition } from "../src/domain/study";

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
