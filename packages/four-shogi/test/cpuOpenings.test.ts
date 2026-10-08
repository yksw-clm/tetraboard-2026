import { expect, test } from "bun:test";
import { getOpeningAction } from "../src/cpuOpenings";
import { chooseCpuActionWithDiagnostics } from "../src/cpu";
import { applyAction } from "../src/index";
import { defaultEvaluationWeights } from "../src/cpuEvaluation";
import { initialPosition } from "../bench/measurement";
import { tacticalCases, acceptsTactic } from "../bench/tactics";

test("序盤候補の系列は全設定で合法で、系列外の局面へ適用しない", () => {
  for (const mode of ["singles", "doubles"] as const)
    for (const restricted of [false, true]) {
      let state = initialPosition(mode, restricted);
      for (let ply = 0; ply < 4; ply++) {
        const before = structuredClone(state);
        const action = getOpeningAction(state)!;
        expect(action).toBeDefined();
        const result = applyAction(state, state.turn!, action);
        expect(result.ok).toBe(true);
        expect(state).toEqual(before);
        if (result.ok) state = result.state;
      }
      expect(getOpeningAction(state)).toBeUndefined();
    }
  expect(getOpeningAction(tacticalCases()[0].state)).toBeUndefined();
});

test("序盤候補は同点時だけ優先し、確定勝利を妨げない", () => {
  const state = initialPosition("singles", true);
  const weights = Object.fromEntries(Object.keys(defaultEvaluationWeights).map((key) => [key, 0]));
  const result = chooseCpuActionWithDiagnostics(state, { maxDepth: 1, evaluationWeights: weights });
  expect(result.action).toEqual(getOpeningAction(state)!);
  const tactic = tacticalCases().find((entry) => entry.id === "last-opponent-false-south")!;
  expect(acceptsTactic(tactic, chooseCpuActionWithDiagnostics(tactic.state).action)).toBe(true);
});

test("評価調整は入力と既定値を変更せず、不正な重みを拒否する", () => {
  const state = initialPosition("singles", false);
  const before = structuredClone(state);
  const options = { maxWork: 30, evaluationWeights: { kingRing: 50 } };
  const result = chooseCpuActionWithDiagnostics(state, options);
  expect(chooseCpuActionWithDiagnostics(state, options)).toEqual(result);
  expect(options.evaluationWeights).toEqual({ kingRing: 50 });
  expect(defaultEvaluationWeights.kingRing).toBe(35);
  expect(Object.isFrozen(defaultEvaluationWeights)).toBe(true);
  expect(state).toEqual(before);
  for (const value of [-1, Infinity, NaN])
    expect(() =>
      chooseCpuActionWithDiagnostics(state, { evaluationWeights: { kingRing: value } }),
    ).toThrow(TypeError);
});
