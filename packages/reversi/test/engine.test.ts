import { expect, test } from "bun:test";
import {
  applyAction,
  chooseCpuMove,
  countStones,
  createInitialState,
  eliminateColor,
  getLegalMoves,
  type ReversiState,
} from "../src";
test("初期配置と黒の4合法手、反転と入力不変", () => {
  const initial = createInitialState();
  const saved = JSON.stringify(initial);
  expect(countStones(initial.board)).toEqual({ black: 2, white: 2 });
  expect(getLegalMoves(initial)).toEqual([
    { x: 3, y: 2 },
    { x: 2, y: 3 },
    { x: 5, y: 4 },
    { x: 4, y: 5 },
  ]);
  const result = applyAction(initial, { type: "placeStone", position: { x: 3, y: 2 } });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.flipped).toEqual([{ x: 3, y: 3 }]);
  expect(result.state.turn).toBe("white");
  expect(countStones(result.state.board)).toEqual({ black: 4, white: 1 });
  expect(JSON.stringify(initial)).toBe(saved);
});
test("不正な座標・占有・挟めない着手を拒否", () => {
  const state = createInitialState();
  for (const position of [
    { x: -1, y: 0 },
    { x: 8, y: 0 },
    { x: 0.5, y: 0 },
    { x: 3, y: 3 },
    { x: 0, y: 0 },
  ])
    expect(applyAction(state, { type: "placeStone", position }).ok).toBe(false);
});
function position(rows: string[]): ReversiState {
  return {
    ...createInitialState(),
    board: rows.map((row) =>
      [...row].map((c) => (c === "K" ? "black" : c === "W" ? "white" : null)),
    ),
  };
}
test("全滅手を許可し、空きマスがあっても双方パスで終局", () => {
  const result = applyAction(position(["KW......", ...Array(7).fill("........")]), {
    type: "placeStone",
    position: { x: 2, y: 0 },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.state.status).toBe("finished");
  expect(result.passedColors).toEqual(["white", "black"]);
  expect(result.state.result).toEqual({
    reason: "all_passed",
    winner: "black",
    stoneCounts: { black: 3, white: 0 },
  });
});
test("自動パス後に同じ人が続けて着手できる", () => {
  const result = applyAction(position(["KW.KW...", ...Array(7).fill("........")]), {
    type: "placeStone",
    position: { x: 2, y: 0 },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.state.turn).toBe("black");
  expect(result.passedColors).toEqual(["white"]);
});
test("盤面充填の引き分けと脱落による石数に依存しない勝敗", () => {
  const rows = [".WKKKKKK", ...Array(3).fill("KKKKKKKK"), ...Array(4).fill("WWWWWWWW")];
  const result = applyAction(position(rows), { type: "placeStone", position: { x: 0, y: 0 } });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.state.result?.reason).toBe("board_full");
  const lost = eliminateColor(createInitialState(), "black");
  expect(lost.ok).toBe(true);
  if (!lost.ok) return;
  expect(lost.state.result?.winner).toBe("white");
  expect(lost.state.result?.reason).toBe("last_player");
  expect(getLegalMoves(lost.state)).toEqual([]);
  expect(applyAction(lost.state, { type: "placeStone", position: { x: 0, y: 0 } }).ok).toBe(false);
});
test("両CPUレベルが通常初期局面から合法手だけで終局する", () => {
  for (const level of [1, 2] as const) {
    let state = createInitialState();
    let moves = 0;
    while (state.status === "playing") {
      const move = chooseCpuMove(state, level, () => 0.4);
      expect(move).not.toBeNull();
      const result = applyAction(state, { type: "placeStone", position: move! });
      expect(result.ok).toBe(true);
      if (!result.ok) throw Error("illegal CPU move");
      state = result.state;
      if (++moves > 60) throw Error("too many moves");
    }
    expect(state.result.stoneCounts.black + state.result.stoneCounts.white).toBe(4 + moves);
    expect(chooseCpuMove(state, level)).toBeNull();
  }
});
test("レベル1の乱数境界とレベル2の決定性", () => {
  const state = createInitialState();
  expect(chooseCpuMove(state, 1, () => 0)).toEqual({ x: 3, y: 2 });
  expect(chooseCpuMove(state, 1, () => 0.999)).toEqual({ x: 4, y: 5 });
  expect(chooseCpuMove(state, 2)).toEqual(chooseCpuMove(state, 2));
});
