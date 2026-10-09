import { createInitialBoard, emptyHands, isInCheck } from "./board";
import { getOrdinaryMoves, hasOrdinaryMove, validateOrdinaryAction } from "./moves";
import {
  handPieceKinds,
  otherSide,
  sides,
  type ApplyActionResult,
  type ExternalEliminationReason,
  type InitialStateOptions,
  type ShogiAction,
  type ShogiState,
  type Side,
} from "./types";
import { defeat } from "./results";
import { recordPosition } from "./repetition";
import { settleMoveLimit } from "./adjudication";
import type { RepetitionLookup } from "./types";
export * from "./types";
export {
  setDrawProposal,
  canProposeImpasse,
  declarationStatus,
  declareEnteringKing,
  impassePoints,
} from "./adjudication";
export { positionKey } from "./repetition";
export { getCheckState } from "./board";

export function createInitialState(options: InitialStateOptions): ShogiState {
  const ids = sides.map((side) => options.players[side]);
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== 2)
    throw new TypeError("Two distinct player IDs are required");
  return recordPosition({
    rulesVersion: 1,
    players: { ...options.players },
    ...createInitialBoard(),
    hands: emptyHands(),
    status: "playing",
    turn: "south",
    result: null,
    eliminations: [],
    drawProposals: [],
    moveNumber: 0,
    lastMove: null,
    repetitions: {},
    nonChecks: { south: 0, north: 0 },
  });
}
export function getLegalActionsForSide(state: ShogiState, side: Side): ShogiAction[] {
  return getOrdinaryMoves(state, side).map((m) => m.action);
}
export function getLegalActions(state: ShogiState): ShogiAction[] {
  return state.status === "finished" ? [] : getLegalActionsForSide(state, state.turn);
}
export function getActionAvailability(state: ShogiState) {
  return { legalActions: getLegalActions(state) };
}
export function applyAction(
  state: ShogiState,
  side: Side,
  action: ShogiAction,
  repetitionLookup?: RepetitionLookup,
): ApplyActionResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  if (state.turn !== side) return { ok: false, reason: "not_your_turn" };
  if (
    !action ||
    (action.type === "movePiece"
      ? typeof action.promote !== "boolean"
      : action.type !== "dropPiece" || !handPieceKinds.includes(action.pieceKind))
  )
    return { ok: false, reason: "invalid_action" };
  const move = validateOrdinaryAction(state, side, action);
  if (!move.ok) return move;
  const next: ShogiState = {
    ...move.move.state,
    status: "playing",
    result: null,
    turn: otherSide(side),
    moveNumber: state.moveNumber + 1,
    lastMove: { side, action, piece: move.move.piece, captured: move.move.captured },
    drawProposals: [],
    nonChecks: {
      ...state.nonChecks,
      [side]: state.nonChecks[side] + (isInCheck(move.move.state, otherSide(side)) ? 0 : 1),
    },
  };
  const settled = hasOrdinaryMove(next, otherSide(side))
    ? next
    : defeat(
        next,
        otherSide(side),
        isInCheck(next, otherSide(side)) ? "checkmate" : "no_legal_actions",
      );
  const final = settleMoveLimit(recordPosition(settled, repetitionLookup));
  return {
    ok: true,
    state: final,
    captured: move.move.captured,
    eliminations: final.eliminations,
  };
}
export function eliminateSide(
  state: ShogiState,
  side: Side,
  reason: ExternalEliminationReason,
): ApplyActionResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  if (reason === "resigned" && state.turn !== side) return { ok: false, reason: "not_your_turn" };
  const next = defeat(state, side, reason);
  return { ok: true, state: next, captured: null, eliminations: next.eliminations };
}
