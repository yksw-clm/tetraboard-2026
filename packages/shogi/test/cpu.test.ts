import { expect, test } from "bun:test";
import {
  applyAction,
  chooseCpuAction,
  createInitialState,
  eliminateSide,
  getLegalActions,
} from "../src";
import { position } from "./fixtures";
test("Lv1は注入した乱数の両端から合法手を選び、終局はnull", () => {
  const state = createInitialState({ players: { south: "a", north: "b" } }),
    actions = getLegalActions(state);
  expect(actions).toContainEqual(chooseCpuAction(state, 1, () => 0)!);
  expect(actions).toContainEqual(chooseCpuAction(state, 1, () => 0.999)!);
  const r = eliminateSide(state, "south", "resigned");
  if (!r.ok) throw new Error("resign");
  expect(chooseCpuAction(r.state, 2)).toBeNull();
});
test("Lv2は入力と基底履歴を変更せず、乱数に依存せず、予算1でも合法手を返す", () => {
  const state = createInitialState({ players: { south: "a", north: "b" } }),
    before = JSON.stringify(state);
  const forbiddenRandom = () => {
    throw new Error("random");
  };
  const first = chooseCpuAction(state, 2, forbiddenRandom, undefined, 64);
  expect(chooseCpuAction(state, 2, forbiddenRandom, undefined, 64)).toEqual(first);
  expect(getLegalActions(state)).toContainEqual(
    chooseCpuAction(state, 2, forbiddenRandom, undefined, 1)!,
  );
  expect(JSON.stringify(state)).toBe(before);
});
test("Lv2はただで取れる飛車を捕獲する", () => {
  const state = position([
    [0, 5, { id: 3, kind: "rook", side: "south", promoted: false }],
    [0, 4, { id: 4, kind: "rook", side: "north", promoted: false }],
  ]);
  const action = chooseCpuAction(state, 2);
  expect(action).toEqual({
    type: "movePiece",
    from: { x: 0, y: 5 },
    to: { x: 0, y: 4 },
    promote: false,
  });
  if (!action) throw new Error("missing");
  expect(applyAction(state, "south", action).ok).toBe(true);
});
