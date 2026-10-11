import { describe, expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  eliminateColor,
  getLegalMoves,
  type Cell,
  type Color,
  type GomokuState,
} from "../src";

export function position(
  rows: string[],
  turn: Color = "black",
  forbiddenRules = false,
): GomokuState {
  const board: Cell[][] = Array.from({ length: 15 }, (_, y) =>
    Array.from(
      { length: 15 },
      (_, x) => (({ K: "black", W: "white" })[rows[y]?.[x]] as Cell) ?? null,
    ),
  );
  return { ...createInitialState(forbiddenRules), board, status: "playing", turn, result: null };
}

describe("五目並べ", () => {
  test("空の15路盤から交互に置き、入力を変更しない", () => {
    const initial = createInitialState();
    const before = structuredClone(initial);
    expect(getLegalMoves(initial)).toHaveLength(225);
    const result = applyAction(initial, { type: "placeStone", position: { x: 7, y: 7 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toMatchObject({ moveNumber: 1, turn: "white", lastMove: { x: 7, y: 7 } });
    expect(result.state.board[7][7]).toBe("black");
    expect(initial).toEqual(before);
    expect(applyAction(result.state, { type: "placeStone", position: { x: 7, y: 7 } })).toEqual({
      ok: false,
      reason: "occupied",
    });
    for (const x of [-1, 15, 1.5, NaN])
      expect(applyAction(initial, { type: "placeStone", position: { x, y: 0 } }).ok).toBe(false);
  });
  test.each([
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ])("全方向の盤端で五連を確定する (%i,%i)", (dx, dy) => {
    const state = createInitialState();
    const board = state.board.map((row) => [...row]);
    const y = dy < 0 ? 4 : 0;
    for (let i = 0; i < 4; i++) board[y + i * dy][i * dx] = "black";
    const result = applyAction(
      { ...state, board },
      { type: "placeStone", position: { x: 4 * dx, y: y + 4 * dy } },
    );
    expect(result.ok && result.state.result).toMatchObject({
      winner: "black",
      reason: "five",
      winningLines: [expect.arrayContaining([{ x: 0, y }])],
    });
  });
  test("塞がれた長連も禁手OFFでは勝ち", () => {
    const result = applyAction(position(["WKKK.KKW"]), {
      type: "placeStone",
      position: { x: 4, y: 0 },
    });
    expect(result.ok && result.state.result).toMatchObject({
      winner: "black",
      winningLines: [expect.arrayContaining([{ x: 6, y: 0 }])],
    });
  });
  test("満盤の最後の五連を引き分けより優先し、外部敗北は手数を増やさない", () => {
    const state = position(Array(15).fill("K".repeat(15)));
    const board = state.board.map((row) => [...row]);
    board[0][0] = null;
    const result = applyAction(
      { ...state, board },
      { type: "placeStone", position: { x: 0, y: 0 } },
    );
    expect(result.ok && result.state.result?.reason).toBe("five");
    const lost = eliminateColor(createInitialState(), "black");
    expect(lost.ok && lost.state).toMatchObject({
      moveNumber: 0,
      result: { winner: "white", reason: "last_player" },
    });
  });
  test("五連のない満盤は引き分け", () => {
    const state = position(
      Array.from({ length: 15 }, (_, y) =>
        Array.from({ length: 15 }, (_, x) => ((x + 2 * y) % 4 < 2 ? "K" : "W")).join(""),
      ),
    );
    const board = state.board.map((row) => [...row]);
    board[0][0] = null;
    const result = applyAction(
      { ...state, board },
      { type: "placeStone", position: { x: 0, y: 0 } },
    );
    expect(result.ok && result.state.result).toMatchObject({ reason: "board_full", winner: null });
  });
});

test("白は禁手ONでも長連で勝ち、連全体を強調する", () => {
  const result = applyAction(position(["KWWW.WWK"], "white", true), {
    type: "placeStone",
    position: { x: 4, y: 0 },
  });
  expect(result.ok && result.state.result).toMatchObject({ winner: "white", reason: "five" });
  expect(result.ok && result.state.result?.winningLines[0]).toHaveLength(6);
});
test("同時に五連になった複数方向をすべて保存する", () => {
  const state = createInitialState();
  const board = state.board.map((row) => [...row]);
  for (const offset of [-2, -1, 1, 2]) {
    board[7][7 + offset] = "black";
    board[7 + offset][7] = "black";
  }
  const result = applyAction({ ...state, board }, { type: "placeStone", position: { x: 7, y: 7 } });
  expect(result.ok && result.state.result?.winningLines.map((line) => line.length)).toEqual([5, 5]);
});
