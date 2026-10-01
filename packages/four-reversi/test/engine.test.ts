import { expect, test } from "bun:test";
import {
  applyAction,
  countStones,
  createInitialState,
  eliminateColor,
  getActiveColors,
  getLegalMoves,
} from "../src/index";
import type { Cell, Color, FourReversiAction, FourReversiState, GameMode } from "../src/index";

const symbols: Record<Color, string> = { black: "K", white: "W", red: "R", blue: "B" };
const symbolToCell: Record<string, Cell> = {
  ".": null,
  K: "black",
  W: "white",
  R: "red",
  B: "blue",
};
const boardText = (board: FourReversiState["board"]): string[] =>
  board.map((row) => row.map((cell) => (cell === null ? "." : symbols[cell])).join(""));
const place = (x: number, y: number): FourReversiAction => ({
  type: "placeStone",
  position: { x, y },
});
const boardFromRows = (rows: string[]): Cell[][] =>
  rows.map((row) => [...row].map((symbol) => symbolToCell[symbol]));

function playing(
  board: Cell[][],
  turn: Color = "black",
  mode: GameMode = "singles",
): FourReversiState {
  return {
    mode,
    status: "playing",
    board,
    turn,
    moveNumber: 0,
    lastMove: null,
    eliminatedColors: [],
    consecutivePasses: [],
    result: null,
  };
}

function boardWithLastEmpty(counts: Record<Color, number>): Cell[][] {
  const board = Array.from({ length: 8 }, (): Cell[] => Array<Cell>(8).fill(null));
  const remaining = { ...counts };
  for (const [x, y, color] of [
    [5, 7, "black"],
    [6, 6, "black"],
    [7, 6, "black"],
    [6, 7, "white"],
  ] as const) {
    board[y][x] = color;
    remaining[color]--;
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if ((x === 7 && y === 7) || board[y][x] !== null) continue;
      const color = (["black", "white", "red", "blue"] as const).find(
        (candidate) => remaining[candidate] > 0,
      );
      if (color === undefined) throw new Error("Invalid board counts");
      board[y][x] = color;
      remaining[color]--;
    }
  }
  expect(remaining).toEqual({ black: 0, white: 0, red: 0, blue: 0 });
  return board;
}

test("初期盤面と黒の手番はルール文書どおり", () => {
  const state = createInitialState("singles");
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
  expect(state.status).toBe("playing");
  expect(state.turn).toBe("black");
  expect(state.moveNumber).toBe(0);
  expect(state.lastMove).toBeNull();
  expect(state.eliminatedColors).toEqual([]);
  expect(state.consecutivePasses).toEqual([]);
  expect(getActiveColors(state)).toEqual(["black", "white", "red", "blue"]);
  expect(createInitialState("doubles").mode).toBe("doubles");
});

test("C4の合法手で赤石を返し、入力を変えずに白の手番へ進む", () => {
  const state = createInitialState("singles");
  const original = structuredClone(state);
  const result = applyAction(state, place(2, 3));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.flipped).toEqual([{ x: 3, y: 3 }]);
  expect(result.passedColors).toEqual([]);
  expect(result.state.board[3][2]).toBe("black");
  expect(result.state.board[3][3]).toBe("black");
  expect(result.state.board[4][2]).toBe("red");
  expect(result.state.turn).toBe("white");
  expect(result.state.moveNumber).toBe(1);
  expect(result.state.lastMove).toEqual({ x: 2, y: 3 });
  expect(state).toEqual(original);
  const whiteMove = getLegalMoves(result.state)[0];
  expect(whiteMove).toBeDefined();
  const next = applyAction(result.state, place(whiteMove.x, whiteMove.y));
  expect(next.ok).toBe(true);
  if (next.ok) {
    expect(next.state.turn).toBe("red");
    expect(next.state.lastMove).toEqual(whiteMove);
    const eliminated = eliminateColor(next.state, "blue");
    if (!eliminated.ok) throw new Error("Could not eliminate player");
    expect(eliminated.state.lastMove).toEqual(whiteMove);
  }
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
  const result = applyAction(playing(board), place(3, 3));
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
  const state = createInitialState("singles");
  expect(applyAction(state, place(-1, 3))).toEqual({ ok: false, reason: "out_of_bounds" });
  expect(applyAction(state, place(3.5, 3))).toEqual({ ok: false, reason: "out_of_bounds" });
  expect(applyAction(state, place(3, 4))).toEqual({ ok: false, reason: "occupied" });
  expect(applyAction(state, place(0, 0))).toEqual({ ok: false, reason: "no_capture" });
});

test("継続中の他色を全滅させる手を合法手に含めない", () => {
  const state = createInitialState("singles");
  const board = state.board.map((row) => [...row]);
  board[4][2] = null;
  const reduced = { ...state, board };
  expect(applyAction(reduced, place(2, 3))).toEqual({
    ok: false,
    reason: "eliminates_player",
  });
  expect(getLegalMoves(reduced)).not.toContainEqual({ x: 2, y: 3 });
  expect(board[3][3]).toBe("red");

  const eliminated = eliminateColor(reduced, "red");
  expect(eliminated.ok).toBe(true);
  if (!eliminated.ok) return;
  const allowed = applyAction(eliminated.state, place(2, 3));
  expect(allowed.ok).toBe(true);
  if (allowed.ok) {
    expect(countStones(allowed.state.board).red).toBe(0);
    expect(allowed.state.eliminatedColors).toEqual(["red"]);
  }
});

test("着手後に複数色を自動パスし、直前の連続パスをリセットする", () => {
  const board = boardFromRows([
    "KW......",
    "BK......",
    "........",
    "........",
    "........",
    "........",
    "........",
    "......RW",
  ]);
  const state = {
    ...playing(board),
    consecutivePasses: ["red", "blue"] as Color[],
  };
  const before = structuredClone(state);
  const result = applyAction(state, place(2, 0));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.passedColors).toEqual(["white", "red"]);
  expect(result.state.status).toBe("playing");
  expect(result.state.turn).toBe("blue");
  expect(result.state.consecutivePasses).toEqual(["white", "red"]);
  expect(result.state.moveNumber).toBe(1);
  expect(state).toEqual(before);
});

test("脱落色を手番から外し、手番外の脱落では現在の手番を維持する", () => {
  const state = createInitialState("singles");
  const dropped = eliminateColor(state, "white");
  expect(dropped.ok).toBe(true);
  if (!dropped.ok) return;
  expect(dropped.state.turn).toBe("black");
  expect(dropped.state.eliminatedColors).toEqual(["white"]);
  const moved = applyAction(dropped.state, place(2, 3));
  expect(moved.ok).toBe(true);
  if (moved.ok) expect(moved.state.turn).toBe("red");
  expect(eliminateColor(dropped.state, "white")).toEqual({
    ok: false,
    reason: "already_eliminated",
  });
  expect(state.eliminatedColors).toEqual([]);
});

test("手番中の脱落では次の継続色へ進め、合法手がなければ自動パスする", () => {
  const board = boardFromRows([
    "KW......",
    "BK......",
    "........",
    "........",
    "........",
    "........",
    "........",
    "......RW",
  ]);
  const state = playing(board, "white");
  const dropped = eliminateColor(state, "white");
  expect(dropped.ok).toBe(true);
  if (!dropped.ok) return;
  expect(dropped.passedColors).toEqual(["red"]);
  expect(dropped.state.turn).toBe("blue");
  expect(dropped.state.consecutivePasses).toEqual(["red"]);
  expect(dropped.state.moveNumber).toBe(0);
  expect(state.eliminatedColors).toEqual([]);
});

test("盤面充填で終局し、終局後の着手と脱落を拒否する", () => {
  const board = boardWithLastEmpty({ black: 20, white: 20, red: 12, blue: 11 });
  const result = applyAction(playing(board), place(7, 7));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.passedColors).toEqual([]);
  expect(result.state.status).toBe("finished");
  expect(result.state.turn).toBeNull();
  expect(result.state.result?.reason).toBe("board_full");
  expect(result.state.moveNumber).toBe(1);
  expect(getLegalMoves(result.state)).toEqual([]);
  expect(applyAction(result.state, place(0, 0))).toEqual({
    ok: false,
    reason: "game_finished",
  });
  expect(eliminateColor(result.state, "red")).toEqual({
    ok: false,
    reason: "game_finished",
  });
});

test("空きマスが残っても継続者全員の連続パスで終局する", () => {
  const board = Array.from({ length: 8 }, (): Cell[] => Array<Cell>(8).fill("black"));
  board[0][1] = "white";
  board[0][2] = null;
  board[2][1] = "red";
  board[4][1] = "blue";
  board[3][1] = "white";
  board[7][7] = null;
  const result = applyAction(playing(board), place(2, 0));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.passedColors).toEqual(["white", "red", "blue", "black"]);
  expect(result.state.status).toBe("finished");
  expect(result.state.result?.reason).toBe("all_passed");
  expect(result.state.consecutivePasses).toEqual(["white", "red", "blue", "black"]);
  expect(result.state.board[7][7]).toBeNull();
});

test("シングルスでは同数を同順位とし、脱落者の石数は結果に入れない", () => {
  const board = boardWithLastEmpty({ black: 29, white: 32, red: 1, blue: 1 });
  const initial = playing(board);
  const red = eliminateColor(initial, "red");
  expect(red.ok).toBe(true);
  if (!red.ok) return;
  const blue = eliminateColor(red.state, "blue");
  expect(blue.ok).toBe(true);
  if (!blue.ok) return;
  const result = applyAction(blue.state, place(7, 7));
  expect(result.ok).toBe(true);
  if (!result.ok || result.state.result?.mode !== "singles") return;
  expect(result.state.result.standings).toEqual([
    { color: "black", rank: 1, stoneCount: 31 },
    { color: "white", rank: 1, stoneCount: 31 },
    { color: "blue", rank: 3 },
    { color: "red", rank: 4 },
  ]);
  expect(initial.board[7][7]).toBeNull();
});

test("シングルスで最後の一人になると1位として終局する", () => {
  let state = createInitialState("singles");
  for (const color of ["white", "red", "blue"] as const) {
    const result = eliminateColor(state, color);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    state = result.state;
  }
  expect(state.status).toBe("finished");
  expect(state.result).toEqual({
    mode: "singles",
    reason: "last_player",
    standings: [
      { color: "black", rank: 1, stoneCount: 2 },
      { color: "blue", rank: 2 },
      { color: "red", rank: 3 },
      { color: "white", rank: 4 },
    ],
  });
});

test("ダブルスはチーム合計で勝敗と引き分けを決める", () => {
  const draw = applyAction(
    playing(boardWithLastEmpty({ black: 20, white: 20, red: 10, blue: 13 }), "black", "doubles"),
    place(7, 7),
  );
  expect(draw.ok).toBe(true);
  if (!draw.ok || draw.state.result?.mode !== "doubles") return;
  expect(draw.state.result.winner).toBeNull();
  expect(draw.state.result.teamTotals).toEqual({ "black-red": 32, "white-blue": 32 });

  const win = applyAction(
    playing(boardWithLastEmpty({ black: 21, white: 19, red: 10, blue: 13 }), "black", "doubles"),
    place(7, 7),
  );
  expect(win.ok).toBe(true);
  if (win.ok && win.state.result?.mode === "doubles") {
    expect(win.state.result.winner).toBe("black-red");
    expect(win.state.result.teamTotals).toEqual({ "black-red": 33, "white-blue": 31 });
  }
});

test("ダブルスは味方でも全滅手を禁止し、誰かの脱落で相手チームが勝つ", () => {
  const state = createInitialState("doubles");
  const board = state.board.map((row) => [...row]);
  board[4][2] = null;
  expect(applyAction({ ...state, board }, place(2, 3))).toEqual({
    ok: false,
    reason: "eliminates_player",
  });

  const original = structuredClone(state);
  const dropped = eliminateColor(state, "red");
  expect(dropped.ok).toBe(true);
  if (!dropped.ok) return;
  expect(dropped.state.status).toBe("finished");
  expect(dropped.state.result).toEqual({
    mode: "doubles",
    reason: "team_eliminated",
    winner: "white-blue",
    stoneCounts: [
      { color: "black", count: 2 },
      { color: "white", count: 2 },
      { color: "blue", count: 2 },
    ],
    teamTotals: null,
  });
  expect(state).toEqual(original);
});
