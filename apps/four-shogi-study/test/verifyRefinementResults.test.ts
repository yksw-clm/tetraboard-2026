import { expect, test } from "bun:test";
import { verifyRefinementLine } from "../bench/verifyTacticalRefinements";
import { fixedRootComparison } from "../bench/tacticsImprovements";
import { tacticInput } from "../bench/tacticsDiagnostics";
import { tacticalCases } from "../../../packages/four-shogi/bench/tactics";
import { restoreStudyPosition } from "../src/domain/study";
import { getAnalysisLegalActions } from "../../../packages/four-shogi/src/analysis";

test("記録したPVを正本で再検証し、手番・評価・予算の改変を拒否する", async () => {
  const tactic = tacticalCases().find((t) => t.id === "inactive-rook-false-north")!;
  const position = await restoreStudyPosition(tacticInput(tactic.state));
  const result = await fixedRootComparison(
    position,
    getAnalysisLegalActions(position).slice(0, 1),
    "dual",
    2,
    { phase: "deep", width: 2, ownWidth: 3 },
    { deadline: performance.now() + 5000, maxWork: 10000, taskMs: 5000 },
  );
  expect(result.complete).toBe(true);
  if (!result.selected?.evaluation) throw new Error("完成評価がありません");
  const candidate = { ...result.selected, evaluation: result.selected.evaluation };
  expect((await verifyRefinementLine(position, candidate, 0)).plies).toBe(2);
  await expect(
    verifyRefinementLine(position, {
      ...candidate,
      line: candidate.line.map((step, i) => (i ? step : { ...step, nextTurn: "north" as const })),
    }),
  ).rejects.toThrow("メタデータ");
  await expect(
    verifyRefinementLine(position, {
      ...candidate,
      line: candidate.line.map((step, i) => (i ? step : { ...step, side: "south" as const })),
    }),
  ).rejects.toThrow("実手番");
  const evaluation = {
    ...candidate.evaluation,
    values: {
      ...candidate.evaluation.values,
      north: {
        ...candidate.evaluation.values.north,
        heuristicScore: (candidate.evaluation.values.north.heuristicScore ?? 0) + 1,
      },
    },
  };
  await expect(verifyRefinementLine(position, { ...candidate, evaluation })).rejects.toThrow(
    "評価",
  );
  await expect(
    verifyRefinementLine(position, { ...candidate, completedDepth: 1 }, 0),
  ).rejects.toThrow("延長上限");
  await expect(verifyRefinementLine(position, { ...candidate, line: [] })).rejects.toThrow(
    "完成PV",
  );
});
