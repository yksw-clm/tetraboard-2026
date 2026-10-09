import {
  otherSide,
  type EliminationReason,
  type GameResult,
  type ShogiState,
  type Side,
} from "./types";
export function finish(state: ShogiState, result: GameResult): ShogiState {
  return { ...state, status: "finished", turn: null, result };
}
export function defeat(state: ShogiState, side: Side, reason: EliminationReason): ShogiState {
  return finish(
    { ...state, eliminations: [{ side, reason, rank: 2, group: 0 }] },
    { winner: otherSide(side), reason },
  );
}
