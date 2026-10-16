import { expect, test } from "bun:test";
import { readReplayAnalysis } from "../src/features/room/fourShogiAnalysis";
import {
  analysisFixture,
  fixtureAnalysis,
  analysisModel,
  analysisCode,
} from "./fixtures/fourShogiAnalysis";
const expected = {
  modelId: analysisModel,
  codeVersion: analysisCode,
  profile: "trial-500ms" as const,
};
for (const prohibited of [true, false])
  test(`ON/OFF=${prohibited}: 全履歴の根から実戦の候補外着手と4人評価・PVを比較し、保存棋譜を変えない`, async () => {
    const fixture = analysisFixture(prohibited),
      before = JSON.stringify(fixture);
    const { root, result } = await fixtureAnalysis(fixture);
    const view = readReplayAnalysis(result, root, expected);
    expect(view.candidates).toHaveLength(5);
    expect(view.actual?.candidate.action).toEqual(root.actual);
    expect(
      view.candidates.some(
        (c) => JSON.stringify(c.candidate.action) === JSON.stringify(root.actual),
      ),
    ).toBe(false);
    expect(view.actual?.candidate.completedDepth).toBe(result.diagnostics.completedDepth);
    expect(view.actual?.line.length).toBeGreaterThan(0);
    expect(view.candidates[0].line[1]).toContain("西");
    expect(result.evaluation?.probabilities).toBeNull();
    expect(JSON.stringify(fixture)).toBe(before);
    const later = await fixtureAnalysis(fixture, 1);
    expect(later.root.position.state.repetitions).not.toEqual(root.position.state.repetitions);
    expect(() => readReplayAnalysis(result, later.root, expected)).toThrow();
  });
test("版・モデル・ルール・予算・候補の深さ・PVの実手番/根拠・勝率の破損を表示前に拒否する", async () => {
  const { root, result } = await fixtureAnalysis(analysisFixture());
  const bad = [
    (r: typeof result) => ({ ...r, versions: { ...r.versions, analysisVersion: "future" } }),
    (r: typeof result) => ({ ...r, model: { ...r.model, usedModelId: null } }),
    (r: typeof result) => ({ ...r, input: { ...r.input, threePlayerAttackProhibited: false } }),
    (r: typeof result) => ({ ...r, settings: { ...r.settings, timeBudgetMs: 30000 } }),
    (r: typeof result) => ({ ...r, comparedAction: null }),
    (r: typeof result) => ({
      ...r,
      candidates: [{ ...r.candidates[0], completedDepth: 1 }, ...r.candidates.slice(1)],
    }),
    (r: typeof result) => ({
      ...r,
      candidates: [
        {
          ...r.candidates[0],
          line: [{ ...r.candidates[0].line[0], side: "north" }, ...r.candidates[0].line.slice(1)],
        },
        ...r.candidates.slice(1),
      ],
    }),
    (r: typeof result) => ({
      ...r,
      candidates: [
        {
          ...r.candidates[0],
          line: [
            {
              ...r.candidates[0].line[0],
              captured: { id: 0, side: "north", kind: "rook", promoted: false },
            },
            ...r.candidates[0].line.slice(1),
          ],
        },
        ...r.candidates.slice(1),
      ],
    }),
    (r: typeof result) => ({
      ...r,
      evaluation: { ...r.evaluation, probabilities: { south: 0.9 } },
    }),
  ];
  for (const change of bad)
    expect(() => readReplayAnalysis(change(result), root, expected)).toThrow();
});
test("終局と外部脱落イベントには実戦の着手を捏造せず確定順位を表示する", async () => {
  const fixture = analysisFixture();
  const { root, result } = await fixtureAnalysis(fixture, fixture.frames.length - 1);
  const view = readReplayAnalysis(result, root, expected);
  expect(view.candidates).toHaveLength(0);
  expect(view.actual).toBeNull();
  expect(result.evaluation?.ranks.every((r) => r.kind === "confirmed")).toBe(true);
  const beforeElimination = await fixtureAnalysis(fixture, 4);
  expect(beforeElimination.root.actual).toBeNull();
  expect(
    readReplayAnalysis(beforeElimination.result, beforeElimination.root, expected).actual,
  ).toBeNull();
});
