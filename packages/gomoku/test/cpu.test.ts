import { expect, test } from "bun:test";
import { applyAction, createInitialState, getLegalMoves, type GomokuState } from "../src";
import { analyzeCpuMove, chooseCpuMove, cpuSearchLimits } from "../src/cpu";

function setup(stones: [number, number, "black" | "white"][], forbiddenRules = true): GomokuState {
  const state = createInitialState(forbiddenRules);
  const board = state.board.map((row) => [...row]);
  for (const [x, y, color] of stones) board[y][x] = color;
  return { ...state, board };
}
test("空盤は中央、Lv1は近傍の合法手から選ぶ", () => {
  expect(chooseCpuMove(createInitialState(), 1)).toEqual({ x: 7, y: 7 });
  const state = setup([[7, 7, "white"]]);
  expect(chooseCpuMove(state, 1, () => 0)).toEqual({ x: 5, y: 5 });
  expect(chooseCpuMove(state, 1, () => 0.999)).toEqual({ x: 9, y: 9 });
});
test.each([true, false])(
  "Lv2は相手の脅威より即勝ちを優先し、勝ちがなければ防ぐ (禁手=%s)",
  (forbiddenRules) => {
    const stones: [number, number, "black" | "white"][] = [3, 4, 5, 6].flatMap(
      (x) =>
        [
          [x, 7, "black"],
          [x, 10, "white"],
        ] as [number, number, "black" | "white"][],
    );
    const state = setup(stones, forbiddenRules);
    const move = chooseCpuMove(state, 2)!;
    expect(applyAction(state, { type: "placeStone", position: move })).toMatchObject({
      ok: true,
      state: { result: { winner: "black" } },
    });
    const defense = setup(
      [...stones.filter((s) => s[2] === "white"), [2, 10, "black"]],
      forbiddenRules,
    );
    expect(chooseCpuMove(defense, 2)).toEqual({ x: 7, y: 10 });
  },
);
test("探索上限と決定性・入力不変を保ち、ON/OFFの両色で合法手を返す", () => {
  for (const forbiddenRules of [true, false]) {
    let state = createInitialState(forbiddenRules);
    for (let i = 0; i < 12 && state.status === "playing"; i++) {
      const before = structuredClone(state);
      const result = analyzeCpuMove(state, 2);
      expect(result.nodes).toBeLessThanOrEqual(cpuSearchLimits.nodes);
      expect(getLegalMoves(state)).toContainEqual(result.move!);
      expect(state).toEqual(before);
      if (i === 4) expect(analyzeCpuMove(state, 2)).toEqual(result);
      const placed = applyAction(state, { type: "placeStone", position: result.move! });
      if (!placed.ok) throw new Error("illegal CPU move");
      state = placed.state;
    }
  }
});
test("両端の四を防げない場合にも合法手を返す", () => {
  const state = setup([3, 4, 5, 6].map((x) => [x, 7, "white"]));
  expect(getLegalMoves(state)).toContainEqual(chooseCpuMove(state, 2)!);
});
