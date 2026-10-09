import { expect, test } from "bun:test";
import {
  applyAction,
  canProposeImpasse,
  declareEnteringKing,
  declarationStatus,
  setDrawProposal,
  type Cell,
  type ShogiAction,
  type ShogiState,
  type RepetitionEntry,
} from "../src";
import { recordPosition } from "../src/repetition";
import { position } from "./fixtures";
const move = (fx: number, fy: number, x: number, y: number): ShogiAction => ({
  type: "movePiece",
  from: { x: fx, y: fy },
  to: { x, y },
  promote: false,
});
function play(state: ShogiState, action: ShogiAction): ShogiState {
  if (state.status !== "playing") throw new Error("finished");
  const r = applyAction(state, state.turn, action);
  if (!r.ok) throw new Error(r.reason);
  return r.state;
}
function cycle(start: ShogiState, actions: readonly ShogiAction[]): ShogiState {
  let s = recordPosition({ ...start, repetitions: {} });
  for (let n = 0; n < 3; n++) for (const a of actions) s = play(s, a);
  return s;
}
test("通常の反復は4回目で引き分け、駒のIDと提案は同一局面に影響しない", () => {
  const s = cycle(position(), [
    move(4, 8, 5, 8),
    move(4, 0, 5, 0),
    move(5, 8, 4, 8),
    move(5, 0, 4, 0),
  ]);
  expect(s.result).toEqual({ winner: null, reason: "repetition" });
  expect(s.moveNumber).toBe(12);
});
test("王手中と王手解除後の両方の起点で、連続王手した側だけが敗北", () => {
  const rook: NonNullable<Cell> = { id: 3, side: "south", kind: "rook", promoted: false };
  const checked = {
    ...position([[4, 2, rook]]),
    status: "playing" as const,
    turn: "north" as const,
    result: null,
  };
  expect(
    cycle(checked, [move(4, 0, 5, 0), move(4, 2, 5, 2), move(5, 0, 4, 0), move(5, 2, 4, 2)]).result,
  ).toEqual({ winner: "north", reason: "perpetual_check" });
  const free = position([[5, 2, rook]]);
  expect(
    cycle(free, [move(5, 2, 4, 2), move(4, 0, 5, 0), move(4, 2, 5, 2), move(5, 0, 4, 0)]).result,
  ).toEqual({ winner: "north", reason: "perpetual_check" });
});
export function entering(count = 10, points = 31): ShogiState {
  const s = position(),
    board = s.board.map((r) => [...r]);
  board[8][4] = null;
  board[0][4] = null;
  board[1][4] = { id: 1, side: "south", kind: "king", promoted: false };
  board[8][8] = { id: 2, side: "north", kind: "king", promoted: false };
  for (let n = 0; n < count; n++) {
    const x = n % 9,
      y = Math.floor(n / 9);
    board[y][x] = { id: n + 3, side: "south", kind: "gold", promoted: false };
  }
  return {
    ...s,
    board,
    hands: {
      ...s.hands,
      south: { ...s.hands.south, pawn: points - count },
      north: { ...s.hands.north, pawn: 24 },
    },
  };
}
test("入玉宣言は23/24/30/31点、9/10枚、499/500手の境界で裁定", () => {
  for (const [points, expected] of [
    [23, "invalid_declaration"],
    [24, "declaration"],
    [30, "declaration"],
    [31, "declaration"],
  ] as const) {
    const r = declareEnteringKing(entering(10, points), "south");
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.state.result).toEqual({
        winner: points < 24 ? "north" : points >= 31 ? "south" : null,
        reason: expected,
      });
  }
  expect(declarationStatus(entering(9, 31), "south").eligible).toBe(false);
  expect(declarationStatus({ ...entering(), moveNumber: 499 }, "south").eligible).toBe(true);
  expect(declarationStatus({ ...entering(), moveNumber: 500 }, "south").eligible).toBe(false);
  expect(declareEnteringKing(entering(), "north")).toEqual({ ok: false, reason: "not_your_turn" });
});
test("宣言の点数に自陣の駒を含めず、成駒の点数は元駒と同じ", () => {
  const s = entering(10, 24),
    board = s.board.map((r) => [...r]);
  board[7][0] = { id: 50, side: "south", kind: "rook", promoted: true };
  expect(declarationStatus({ ...s, board }, "south").points).toBe(24);
});
test("持将棋は入玉・王手なしの局面だけ、手番外の同意と23/24点、着手で解除", () => {
  expect(canProposeImpasse(position())).toBe(false);
  expect(setDrawProposal(position(), "south", true)).toEqual({
    ok: false,
    reason: "impasse_unavailable",
  });
  for (const points of [23, 24]) {
    const s = entering(10, points),
      snapshot = JSON.stringify(s),
      first = setDrawProposal(s, "north", true);
    expect(first.ok).toBe(true);
    expect(JSON.stringify(s)).toBe(snapshot);
    if (!first.ok) continue;
    expect(first.state.moveNumber).toBe(0);
    expect(first.state.turn).toBe("south");
    const second = setDrawProposal(first.state, "south", true);
    expect(second.ok).toBe(true);
    if (second.ok)
      expect(second.state.result).toEqual({
        winner: points === 23 ? "north" : null,
        reason: "impasse",
      });
    const moved = play(first.state, move(8, 0, 8, 1));
    expect(moved.drawProposals).toEqual([]);
  }
});
test("500手で引き分け、王手がある間は延期し、解除した501手で終局", () => {
  expect(play({ ...position(), moveNumber: 499 }, move(4, 8, 5, 8)).result).toEqual({
    winner: null,
    reason: "move_limit",
  });
  const s = {
    ...position([[5, 2, { id: 3, side: "south", kind: "rook", promoted: false }]]),
    moveNumber: 499,
  };
  const checked = play(s, move(5, 2, 4, 2));
  expect(checked.status).toBe("playing");
  expect(play(checked, move(4, 0, 5, 0)).result).toEqual({ winner: null, reason: "move_limit" });
});

test("局面ごとの履歴参照でも完全辞書と同じ千日手を再現し、検索中は基底履歴を変更しない", () => {
  let full = recordPosition({ ...position(), repetitions: {} });
  const entries = new Map<string, RepetitionEntry>(Object.entries(full.repetitions));
  let sparse = { ...full, repetitions: {} };
  const actions = [move(4, 8, 5, 8), move(4, 0, 5, 0), move(5, 8, 4, 8), move(5, 0, 4, 0)];
  for (let n = 0; n < 12; n++) {
    if (full.status !== "playing" || sparse.status !== "playing")
      throw new Error("finished too early");
    const prior = JSON.stringify([...entries]);
    const a = applyAction(full, full.turn, actions[n % 4]);
    const b = applyAction(sparse, sparse.turn, actions[n % 4], (key) => entries.get(key));
    expect(a.ok && b.ok).toBe(true);
    expect(JSON.stringify([...entries])).toBe(prior);
    if (!a.ok || !b.ok) throw new Error("invalid move");
    full = a.state;
    for (const [key, entry] of Object.entries(b.state.repetitions)) entries.set(key, entry);
    sparse = { ...b.state, repetitions: {} };
    const { repetitions: _a, ...left } = full;
    const { repetitions: _b, ...right } = sparse;
    expect(right).toEqual(left);
  }
});
