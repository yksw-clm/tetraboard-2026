import { expect, test } from "bun:test";
import { applyAction, createInitialState, getLegalMoves } from "../src/index";
import type { Cell, Color, FourReversiAction, FourReversiState } from "../src/index";

const symbols: Record<Color, string> = { black: "K", white: "W", red: "R", blue: "B" };
const boardText = (board: FourReversiState["board"]): string[] =>
  board.map((row) => row.map((cell) => (cell === null ? "." : symbols[cell])).join(""));
const place = (x: number, y: number): FourReversiAction => ({
  type: "placeStone",
  position: { x, y },
});

test("初期盤面と黒の手番はルール文書どおり", () => {
  const state = createInitialState();
  expect(boardText(state.board)).toEqual([
    "........",
    "........",
    "...K....",
    "...RKB..",
    "..RWB...",
    "....W...",
    "........",
    "........",
  ]);
  expect(state.turn).toBe("black");
  expect(state.moveNumber).toBe(0);
});

test("C4の合法手で赤石を返し、入力を変えずに白の手番へ進む", () => {
  const state = createInitialState();
  const original = structuredClone(state);
  const result = applyAction(state, place(2, 3));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.flipped).toEqual([{ x: 3, y: 3 }]);
  expect(result.state.board[3][2]).toBe("black");
  expect(result.state.board[3][3]).toBe("black");
  expect(result.state.board[4][2]).toBe("red");
  expect(result.state.turn).toBe("white");
  expect(result.state.moveNumber).toBe(1);
  expect(state).toEqual(original);
  const whiteMove = getLegalMoves(result.state)[0];
  expect(whiteMove).toBeDefined();
  const next = applyAction(result.state, place(whiteMove.x, whiteMove.y));
  expect(next.ok).toBe(true);
  if (next.ok) expect(next.state.turn).toBe("red");
});

test("複数方向で複数色が連続していても同時に返す", () => {
  const board = Array.from({ length: 8 }, (): Cell[] => Array<Cell>(8).fill(null));
  board[0][0] = "red";
  board[0][1] = "white";
  board[0][2] = "blue";
  board[3][4] = "red";
  board[3][5] = "white";
  board[3][6] = "black";
  board[4][3] = "blue";
  board[5][3] = "black";
  const result = applyAction({ board, turn: "black", moveNumber: 3 }, place(3, 3));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.flipped).toEqual([
    { x: 4, y: 3 },
    { x: 5, y: 3 },
    { x: 3, y: 4 },
  ]);
  expect(result.state.board[3][4]).toBe("black");
  expect(result.state.board[3][5]).toBe("black");
  expect(result.state.board[4][3]).toBe("black");
  expect(board[3][4]).toBe("red");
});

test("範囲外、占有済み、返せない手を拒否する", () => {
  const state = createInitialState();
  expect(applyAction(state, place(-1, 3))).toEqual({ ok: false, reason: "out_of_bounds" });
  expect(applyAction(state, place(3.5, 3))).toEqual({ ok: false, reason: "out_of_bounds" });
  expect(applyAction(state, place(3, 4))).toEqual({ ok: false, reason: "occupied" });
  expect(applyAction(state, place(0, 0))).toEqual({ ok: false, reason: "no_capture" });
});

test("他色を全滅させる手を合法手に含めない", () => {
  const state = createInitialState();
  const board = state.board.map((row) => [...row]);
  board[4][2] = null;
  const reduced = { ...state, board };
  expect(applyAction(reduced, place(2, 3))).toEqual({
    ok: false,
    reason: "eliminates_player",
  });
  expect(getLegalMoves(reduced)).not.toContainEqual({ x: 2, y: 3 });
  expect(board[3][3]).toBe("red");
});
