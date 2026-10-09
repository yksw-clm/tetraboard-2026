import { applyAction, getLegalActions } from "./index";
import { attacksSquare, isInCheck, pieces } from "./board";
import { declarationStatus } from "./adjudication";
import {
  handPieceKinds,
  otherSide,
  type RepetitionLookup,
  type ShogiAction,
  type ShogiState,
  type Side,
} from "./types";
export type CpuLevel = 1 | 2;
const values = {
  king: 0,
  pawn: 100,
  lance: 300,
  knight: 300,
  silver: 400,
  gold: 500,
  bishop: 700,
  rook: 800,
} as const;
const promotedValue = (kind: keyof typeof values, promoted: boolean) =>
  promoted ? (kind === "rook" ? 1000 : kind === "bishop" ? 950 : 500) : values[kind];
function evaluate(state: ShogiState, side: Side): number {
  if (state.status === "finished")
    return state.result.winner === null ? 0 : state.result.winner === side ? 1_000_000 : -1_000_000;
  const located = pieces(state.board);
  let score = 0;
  for (const { piece, position } of located) {
    const sign = piece.side === side ? 1 : -1;
    score += sign * promotedValue(piece.kind, piece.promoted);
    if (piece.kind !== "king") {
      score += sign * (piece.side === "south" ? 8 - position.y : position.y) * 3;
      const threatened = located.some(
        (p) =>
          p.piece.side !== piece.side && attacksSquare(state.board, p.piece, p.position, position),
      );
      const defended = located.some(
        (p) =>
          p.piece.side === piece.side &&
          p.piece.id !== piece.id &&
          attacksSquare(state.board, p.piece, p.position, position),
      );
      if (threatened && !defended) score -= sign * promotedValue(piece.kind, piece.promoted) * 0.25;
    }
  }
  for (const kind of handPieceKinds)
    score += (state.hands[side][kind] - state.hands[otherSide(side)][kind]) * values[kind];
  if (isInCheck(state, side)) score -= 60;
  if (isInCheck(state, otherSide(side))) score += 60;
  return score;
}
function order(state: ShogiState, actions: ShogiAction[]): ShogiAction[] {
  const priority = (a: ShogiAction) =>
    a.type === "movePiece"
      ? (state.board[a.to.y][a.to.x] ? values[state.board[a.to.y][a.to.x]!.kind] * 10 : 0) +
        (a.promote ? 100 : 0)
      : 0;
  return actions
    .map((action, index) => ({ action, index, priority: priority(action) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map((a) => a.action);
}
/** 時計ではなく着手評価の回数で探索を制限し、最後の完了深さの手を返します。 */
export function chooseCpuAction(
  state: ShogiState,
  level: CpuLevel,
  random: () => number = Math.random,
  lookup?: RepetitionLookup,
  maxWork = 512,
): ShogiAction | null {
  if (state.status === "finished") return null;
  const actions = order(state, getLegalActions(state));
  if (actions.length === 0) return null;
  if (level === 1)
    return actions[
      Math.min(actions.length - 1, Math.max(0, Math.floor(random() * actions.length)))
    ];
  if (!Number.isInteger(maxWork) || maxWork < 1) throw new TypeError("Invalid search budget");
  const side = state.turn;
  let work = 0,
    best = actions[0];
  const cutoff = Symbol("budget");
  function search(current: ShogiState, depth: number, alpha: number, beta: number): number {
    if (current.status === "finished" || depth === 0) return evaluate(current, side);
    const declaration = declarationStatus(current, current.turn);
    if (declaration.eligible && declaration.outcome === "win")
      return current.turn === side ? 1_000_000 : -1_000_000;
    const maximizing = current.turn === side;
    let value = maximizing ? -Infinity : Infinity;
    for (const action of order(current, getLegalActions(current))) {
      if (work >= maxWork) throw cutoff;
      work++;
      const result = applyAction(current, current.turn, action, lookup);
      if (!result.ok) throw new Error("Illegal CPU candidate");
      const score = search(result.state, depth - 1, alpha, beta);
      value = maximizing ? Math.max(value, score) : Math.min(value, score);
      if (maximizing) alpha = Math.max(alpha, value);
      else beta = Math.min(beta, value);
      if (alpha >= beta) break;
    }
    return value;
  }
  for (let depth = 1; depth <= 3; depth++) {
    let candidate = actions[0],
      score = -Infinity,
      completed = true;
    try {
      for (const action of actions) {
        if (work >= maxWork) throw cutoff;
        work++;
        const result = applyAction(state, side, action, lookup);
        if (!result.ok) throw new Error("Illegal CPU root");
        const value = search(result.state, depth - 1, score, Infinity);
        if (value > score) {
          score = value;
          candidate = action;
        }
      }
    } catch (error) {
      if (error !== cutoff) throw error;
      completed = false;
    }
    if (completed || depth === 1) best = candidate;
    if (!completed || score >= 1_000_000) break;
  }
  return best;
}
