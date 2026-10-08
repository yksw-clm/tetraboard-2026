import { expect, test } from "bun:test";
import { searchCpuAction } from "../src/cpuSearch";
import { applyAction, getLegalActions } from "../src/index";
import { initialPosition } from "../bench/measurement";
import { fixture } from "./helpers";
import { tacticalCases } from "../bench/tactics";
import { getLegalActionsForSide } from "../src/index";
import { move, succeeded } from "./helpers";

test("小さい探索予算でも合法手を返し、時計と乱数に依存せず入力を維持する", () => {
  const state = initialPosition("singles", true);
  const before = structuredClone(state);
  const result = searchCpuAction(state, { maxWork: 1 });
  expect(result.stats.cutoff).toBe(true);
  expect(result.stats.work).toBeLessThanOrEqual(1);
  expect(getLegalActions(state)).toContainEqual(result.action!);
  expect(searchCpuAction(state, { maxWork: 1 })).toEqual(result);
  expect(state).toEqual(before);
});

test("ダブルスと二人生存では実際の手番に従った二者探索を使う", () => {
  for (const state of [
    initialPosition("doubles", false),
    fixture({
      eliminations: [
        { side: "north", reason: "left", rank: 4, group: 1 },
        { side: "east", reason: "left", rank: 3, group: 2 },
      ],
    }),
  ]) {
    const result = searchCpuAction(state, { maxWork: 80 });
    expect(result.stats.algorithm).toBe("alpha-beta");
    expect(applyAction(state, state.turn!, result.action!).ok).toBe(true);
  }
});

test("不正な探索予算を拒否する", () => {
  const state = initialPosition("singles", true);
  for (const maxWork of [0, -1, Infinity, NaN, 1.5])
    expect(() => searchCpuAction(state, { maxWork })).toThrow(TypeError);
});

test("マジックは下家へ王手し、取り返す二人の前に自手番が戻る", () => {
  const state = tacticalCases().find((entry) => entry.id === "magic-recapture-false-south")!.state;
  const captured = succeeded(applyAction(state, "south", move("E5", "C5"))).state;
  expect(captured.turn).toBe("east");
  expect(getLegalActionsForSide(captured, "west")).toContainEqual(move("C9", "C5"));
  expect(applyAction(captured, "west", move("C9", "C5"))).toEqual({
    ok: false,
    reason: "not_your_turn",
  });
  for (const reply of getLegalActions(captured)) {
    expect(succeeded(applyAction(captured, "east", reply)).state.turn).toBe("south");
  }
  const evaded = succeeded(applyAction(captured, "east", move("I5", "I4"))).state;
  const second = succeeded(applyAction(evaded, "south", move("C5", "C4")));
  expect(second.captured?.kind).toBe("gold");
  expect(second.state.turn).toBe("east");
});

test("戦術延長と履歴付きキャッシュも探索予算内で決定的に動く", () => {
  const state = tacticalCases().find((entry) => entry.id === "magic-recapture-true-south")!.state;
  const before = structuredClone(state);
  const result = searchCpuAction(state, { maxWork: 400 });
  expect(result.stats.work).toBeLessThanOrEqual(400);
  expect(result.stats.extendedNodes).toBeGreaterThan(0);
  expect(searchCpuAction(state, { maxWork: 400 })).toEqual(result);
  expect(state).toEqual(before);
});
