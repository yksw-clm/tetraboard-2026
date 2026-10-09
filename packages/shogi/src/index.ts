import { createInitialBoard, emptyHands, isInCheck } from "./board";
import { getOrdinaryMoves, hasOrdinaryMove, validateOrdinaryAction } from "./moves";
import {
  handPieceKinds,
  otherSide,
  sides,
  type ApplyActionResult,
  type ExternalEliminationReason,
  type GameResult,
  type InitialStateOptions,
  type ShogiAction,
  type ShogiState,
  type Side,
} from "./types";
export * from "./types";
export { getCheckState } from "./board";

export function createInitialState(options: InitialStateOptions): ShogiState {
  const ids = sides.map((side) => options.players[side]);
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== 2)
    throw new TypeError("Two distinct player IDs are required");
  return {
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
  };
}
export function finish(state: ShogiState, result: GameResult): ShogiState {
  return { ...state, status: "finished", turn: null, result };
}
export function defeat(
  state: ShogiState,
  side: Side,
  reason:
    | ExternalEliminationReason
    | "checkmate"
    | "no_legal_actions"
    | "perpetual_check"
    | "impasse"
    | "invalid_declaration",
): ShogiState {
  return finish(
    { ...state, eliminations: [{ side, reason, rank: 2, group: 0 }] },
    { winner: otherSide(side), reason },
  );
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
export function applyAction(state: ShogiState, side: Side, action: ShogiAction): ApplyActionResult {
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
  };
  const settled = hasOrdinaryMove(next, otherSide(side))
    ? next
    : defeat(
        next,
        otherSide(side),
        isInCheck(next, otherSide(side)) ? "checkmate" : "no_legal_actions",
      );
  return {
    ok: true,
    state: settled,
    captured: move.move.captured,
    eliminations: settled.eliminations,
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
