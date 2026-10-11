import { expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  forbiddenReasons,
  getLegalMoves,
  settleNoLegalMoves,
  type Cell,
} from "../src";

function board(black: number[][], white: number[][] = []): Cell[][] {
  const result = createInitialState().board.map((row) => [...row]);
  for (const [x, y] of black) result[y][x] = "black";
  for (const [x, y] of white) result[y][x] = "white";
  return result;
}
const center = { x: 7, y: 7 };
const cross = [
  [6, 7],
  [8, 7],
  [7, 6],
  [7, 8],
];
test("三三の拒否は入力・手数・直前手を変更せず、白とOFFは許可する", () => {
  const state = { ...createInitialState(), board: board(cross) };
  const before = structuredClone(state);
  expect(applyAction(state, { type: "placeStone", position: center })).toEqual({
    ok: false,
    reason: "forbidden",
    forbidden: ["double_three"],
  });
  expect(state).toEqual(before);
  expect(
    applyAction({ ...state, forbiddenRules: false }, { type: "placeStone", position: center }).ok,
  ).toBe(true);
  expect(
    applyAction(
      { ...state, status: "playing", turn: "white", result: null },
      { type: "placeStone", position: center },
    ).ok,
  ).toBe(true);
});
test("両端が開いた四は一つ、同方向の異なる四は二つ", () => {
  expect(
    forbiddenReasons(
      board([
        [5, 7],
        [6, 7],
        [8, 7],
      ]),
      center,
    ),
  ).toEqual([]);
  expect(
    forbiddenReasons(
      board([
        [4, 7],
        [6, 7],
        [8, 7],
        [10, 7],
      ]),
      center,
    ),
  ).toContain("double_four");
  expect(
    forbiddenReasons(
      board([
        [5, 7],
        [6, 7],
        [8, 7],
        [7, 5],
        [7, 6],
        [7, 8],
      ]),
      center,
    ),
  ).toContain("double_four");
});
test("長連を拒否するが別方向の五連を同時に作れば勝ち", () => {
  const black = [
    [3, 7],
    [4, 7],
    [5, 7],
    [6, 7],
    [8, 7],
  ];
  expect(forbiddenReasons(board(black), center)).toEqual(["overline"]);
  const state = {
    ...createInitialState(),
    board: board([...black, [7, 3], [7, 4], [7, 5], [7, 6]]),
  };
  expect(forbiddenReasons(state.board, center)).toEqual([]);
  expect(applyAction(state, { type: "placeStone", position: center })).toMatchObject({
    ok: true,
    state: { result: { reason: "five", winner: "black" } },
  });
});
test("盤端・白の妨害・長連となる発展先は三に数えない", () => {
  expect(
    forbiddenReasons(
      board(cross, [
        [5, 7],
        [9, 7],
      ]),
      center,
    ),
  ).toEqual([]);
  expect(
    forbiddenReasons(
      board([
        [0, 1],
        [0, 2],
        [1, 0],
        [2, 0],
      ]),
      { x: 0, y: 0 },
    ),
  ).toEqual([]);
  const extensions = [5, 9].flatMap((x) => [2, 3, 4, 5, 6].map((y) => [x, y]));
  expect(forbiddenReasons(board([...cross, ...extensions]), center)).toEqual([]);
});
test("発展先が四四になる見かけの三三を許可する", () => {
  const extensions = [5, 9].flatMap((x) => [4, 5, 6].map((y) => [x, y]));
  expect(forbiddenReasons(board([...cross, ...extensions]), center)).toEqual([]);
});
test("再帰的な三三によって発展できない三は除外する", () => {
  const stones = board([...cross, [5, 5], [5, 6], [3, 5], [4, 6], [9, 5], [9, 6], [8, 8], [10, 6]]);
  expect(forbiddenReasons(stones, center)).toEqual([]);
  stones[7][7] = "black";
  for (const x of [5, 9]) expect(forbiddenReasons(stones, { x, y: 7 })).toContain("double_three");
});
test("空点が禁手だけなら白勝ち、遠い合法点があれば継続、満盤は引き分け", () => {
  const full: Cell[][] = Array.from({ length: 15 }, () => Array<Cell>(15).fill("black"));
  full[7][7] = null;
  const state = { ...createInitialState(), board: full };
  expect(getLegalMoves(state)).toEqual([]);
  expect(settleNoLegalMoves(state).result).toMatchObject({
    reason: "no_legal_moves",
    winner: "white",
  });
  const distant = full.map((row) => [...row]);
  distant[0][0] = null;
  distant[0][1] = "white";
  distant[1][0] = "white";
  distant[1][1] = "white";
  expect(settleNoLegalMoves({ ...state, board: distant }).status).toBe("playing");
  full[7][7] = "black";
  expect(settleNoLegalMoves(state).result).toMatchObject({ reason: "board_full", winner: null });
});
