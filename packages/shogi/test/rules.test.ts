import { expect, test } from "bun:test";
import {
  applyAction,
  createInitialState,
  getLegalActions,
  type Cell,
  type ShogiState,
} from "../src";
import { attacksSquare } from "../src/board";
const initial = () => createInitialState({ players: { south: "a", north: "b" } });
export function position(entries: readonly [number, number, NonNullable<Cell>][] = []): ShogiState {
  const state = initial(),
    board: Cell[][] = Array.from({ length: 9 }, () => Array<Cell>(9).fill(null));
  board[8][4] = { id: 1, side: "south", kind: "king", promoted: false };
  board[0][4] = { id: 2, side: "north", kind: "king", promoted: false };
  for (const [x, y, p] of entries) board[y][x] = p;
  return { ...state, board, nextPieceId: 100 };
}
test("初期配置は40枚、先手の角B8と飛H8、後手は180度回転、合法手30手", () => {
  const s = initial();
  expect(s.board.flat().filter(Boolean)).toHaveLength(40);
  expect(s.board[7][1]?.kind).toBe("bishop");
  expect(s.board[7][7]?.kind).toBe("rook");
  expect(s.board[1][7]?.kind).toBe("bishop");
  expect(getLegalActions(s)).toHaveLength(30);
});
test("着手は交互、入力不変、手番違いと王手放置を拒否", () => {
  const s = initial(),
    saved = JSON.stringify(s),
    a = getLegalActions(s)[0];
  const r = applyAction(s, "south", a);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.state.turn).toBe("north");
    expect(r.state.moveNumber).toBe(1);
  }
  expect(JSON.stringify(s)).toBe(saved);
  expect(applyAction(s, "north", a)).toEqual({ ok: false, reason: "not_your_turn" });
  const checked = position([[4, 4, { id: 3, kind: "rook", side: "north", promoted: false }]]);
  expect(
    applyAction(checked, "south", {
      type: "movePiece",
      from: { x: 4, y: 8 },
      to: { x: 4, y: 7 },
      promote: false,
    }),
  ).toEqual({ ok: false, reason: "self_check" });
});
test("桂は飛び越え、香は前だけ、角と馬と龍の移動と遮蔽", () => {
  const s = initial(),
    board = s.board;
  expect(
    attacksSquare(
      board,
      { id: 1, kind: "knight", side: "south", promoted: false },
      { x: 1, y: 8 },
      { x: 2, y: 6 },
    ),
  ).toBe(true);
  expect(
    attacksSquare(
      board,
      { id: 1, kind: "lance", side: "south", promoted: false },
      { x: 0, y: 8 },
      { x: 0, y: 5 },
    ),
  ).toBe(false);
  const empty = position().board;
  for (const [kind, dx, dy, promoted, expected] of [
    ["bishop", 2, -2, false, true],
    ["bishop", 1, 0, false, false],
    ["bishop", 1, 0, true, true],
    ["rook", 1, -1, true, true],
    ["lance", 0, 1, false, false],
    ["lance", 0, 1, true, true],
  ] as const)
    expect(
      attacksSquare(
        empty,
        { id: 3, side: "south", kind, promoted },
        { x: 3, y: 4 },
        { x: 3 + dx, y: 4 + dy },
      ),
    ).toBe(expected);
});
test("桂の最後2段・香と歩の最終段は強制成り、打てない", () => {
  for (const kind of ["knight", "lance", "pawn"] as const) {
    const from = { x: 0, y: kind === "knight" ? 2 : 1 },
      to = { x: kind === "knight" ? 1 : 0, y: 0 };
    const s = position([[from.x, from.y, { id: 3, side: "south", kind, promoted: false }]]);
    expect(applyAction(s, "south", { type: "movePiece", from, to, promote: false })).toEqual({
      ok: false,
      reason: "promotion_required",
    });
    expect(applyAction(s, "south", { type: "movePiece", from, to, promote: true }).ok).toBe(true);
    const hand = { ...s, hands: { ...s.hands, south: { ...s.hands.south, [kind]: 1 } } };
    expect(applyAction(hand, "south", { type: "dropPiece", pieceKind: kind, to })).toEqual({
      ok: false,
      reason: "dead_end_piece",
    });
  }
});
test("成角を捕獲すると不成の角が持ち駒になり、二歩と王の捕獲は禁止", () => {
  const s = position([
    [0, 5, { id: 3, side: "south", kind: "rook", promoted: false }],
    [0, 4, { id: 4, side: "north", kind: "bishop", promoted: true }],
  ]);
  const r = applyAction(s, "south", {
    type: "movePiece",
    from: { x: 0, y: 5 },
    to: { x: 0, y: 4 },
    promote: false,
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.state.hands.south.bishop).toBe(1);
  const p = initial(),
    hand = { ...p, hands: { ...p.hands, south: { ...p.hands.south, pawn: 1 } } };
  expect(
    applyAction(hand, "south", { type: "dropPiece", pieceKind: "pawn", to: { x: 0, y: 4 } }),
  ).toEqual({ ok: false, reason: "nifu" });
});

test("打ち歩詰めは拒否し、同じ詰みの突き歩は受理して終局する", () => {
  const blocked: [number, number, NonNullable<Cell>][] = [
    [3, 0, { id: 4, side: "north", kind: "lance", promoted: false }],
    [5, 0, { id: 5, side: "north", kind: "lance", promoted: false }],
    [3, 1, { id: 6, side: "north", kind: "pawn", promoted: false }],
    [5, 1, { id: 7, side: "north", kind: "pawn", promoted: false }],
  ];
  const s = position([...blocked, [4, 2, { id: 3, side: "south", kind: "rook", promoted: false }]]);
  const hand = { ...s, hands: { ...s.hands, south: { ...s.hands.south, pawn: 1 } } };
  expect(
    applyAction(hand, "south", { type: "dropPiece", pieceKind: "pawn", to: { x: 4, y: 1 } }),
  ).toEqual({ ok: false, reason: "pawn_drop_mate" });
  const moving = position([
    ...blocked,
    [4, 3, { id: 3, side: "south", kind: "rook", promoted: false }],
    [4, 2, { id: 8, side: "south", kind: "pawn", promoted: false }],
  ]);
  const r = applyAction(moving, "south", {
    type: "movePiece",
    from: { x: 4, y: 2 },
    to: { x: 4, y: 1 },
    promote: false,
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.state.result).toEqual({ winner: "south", reason: "checkmate" });
});

test("後手の桂も最終2段を強制成りとし、王の捕獲は受理しない", () => {
  const s = {
    ...position([[0, 6, { id: 3, side: "north", kind: "knight", promoted: false }]]),
    status: "playing" as const,
    result: null,
    turn: "north" as const,
  };
  expect(
    applyAction(s, "north", {
      type: "movePiece",
      from: { x: 0, y: 6 },
      to: { x: 1, y: 8 },
      promote: false,
    }),
  ).toEqual({ ok: false, reason: "promotion_required" });
  const capture = position([[4, 1, { id: 3, side: "south", kind: "rook", promoted: false }]]);
  expect(
    applyAction(capture, "south", {
      type: "movePiece",
      from: { x: 4, y: 1 },
      to: { x: 4, y: 0 },
      promote: false,
    }),
  ).toEqual({ ok: false, reason: "king_capture" });
});
