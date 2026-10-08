import { getLegalMovesWithAttacks, updateAttackHistory } from "./attacks";
import { getOrdinaryMoves, type OrdinaryMove } from "./moves";
import { settlePosition } from "./progression";
import type { RepetitionLookup } from "./repetition";
import type { FourShogiState, Side, TransitionSuccess } from "./types";

export function getLegalMoves(state: FourShogiState): OrdinaryMove[] {
  return state.status === "finished"
    ? []
    : getLegalMovesWithAttacks(state, state.turn, getOrdinaryMoves(state, state.turn));
}

// 同じ入力から合法性を確認した候補だけを受け取り、実対局と探索の確定処理を共有します。
export function applyLegalMove(
  state: FourShogiState,
  side: Side,
  move: OrdinaryMove,
  repetitionLookup?: RepetitionLookup,
): TransitionSuccess {
  const action = move.action;
  const moved: FourShogiState = {
    ...move.state,
    ...updateAttackHistory(state, side, move),
    moveNumber: state.moveNumber + 1,
    lastMove: {
      side,
      action:
        action.type === "movePiece"
          ? { ...action, from: { ...action.from }, to: { ...action.to } }
          : { ...action, to: { ...action.to } },
      piece: { ...move.piece },
      captured: move.captured === null ? null : { ...move.captured },
    },
  };
  const settled = settlePosition(moved, side, false, repetitionLookup);
  return {
    ok: true,
    state: settled,
    captured: move.captured === null ? null : { ...move.captured },
    eliminations: settled.eliminations.slice(state.eliminations.length),
  };
}
