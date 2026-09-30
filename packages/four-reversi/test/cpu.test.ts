import { expect, test } from "bun:test";
import { chooseCpuMove, createInitialState, getLegalMoves, type Cell } from "../src/index";

test("レベル1は乱数で選んだ合法手を返す", () => {
  const state = createInitialState("singles");
  const moves = getLegalMoves(state);
  expect(chooseCpuMove(state, 1, () => 0)).toEqual(moves[0]);
  expect(chooseCpuMove(state, 1, () => 0.999999)).toEqual(moves[moves.length - 1]!);
});

test("レベル2は返せる角を優先し、状態を変更しない", () => {
  const state = createInitialState("singles");
  const board: Cell[][] = state.board.map((row) => [...row]);
  board[0][1] = "white";
  board[0][2] = "black";
  const position = chooseCpuMove({ ...state, board }, 2);
  expect(position).toEqual({ x: 0, y: 0 });
  expect(board[0][0]).toBeNull();
});
