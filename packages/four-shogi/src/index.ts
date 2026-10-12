import { getLegalMovesWithAttacks, requiresAttackFiltering } from "./attacks";
import { createInitialBoard, emptyHands } from "./board";
import { getOrdinaryMoves, validateOrdinaryAction } from "./moves";
import { eliminateBatch, finishIfDrawAgreed, settlePosition } from "./progression";
import { recordPosition, type RepetitionLookup } from "./repetition";
import { applyLegalMove } from "./transition";
import { getActiveSides, handPieceKinds, sides } from "./types";
import type {
  ApplyActionResult,
  EliminateSideResult,
  ExternalEliminationReason,
  FourShogiAction,
  FourShogiState,
  InitialStateOptions,
  Side,
  SetDrawProposalResult,
} from "./types";

export type { RepetitionLookup } from "./repetition";
export {
  detectFormations,
  formationAnalyzerId,
  formationAnalysisVersion,
  formationIds,
} from "./formations";
export type { FormationPosition, FormationId, FormationMatch } from "./formations";
export { getActiveSides, sides, handPieceKinds } from "./types";
export { getCheckState } from "./board";
export { chooseCpuAction, type CpuLevel } from "./cpu";
export type {
  ApplyActionResult,
  AttackReason,
  AttackRelation,
  Board,
  Cell,
  EliminateSideResult,
  Elimination,
  EliminationReason,
  ExternalEliminationReason,
  FourShogiAction,
  FourShogiState,
  GameMode,
  GameResult,
  Hand,
  HandPieceKind,
  Hands,
  InitialStateOptions,
  MoveError,
  MoveRecord,
  Piece,
  PieceKind,
  Position,
  Side,
  SetDrawProposalResult,
  Team,
  TransitionSuccess,
} from "./types";

export function createInitialState(options: InitialStateOptions): FourShogiState {
  const ids = sides.map((side) => options.players[side]);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== 4) {
    throw new TypeError("Four distinct player IDs are required");
  }
  if (options.mode !== "singles" && options.mode !== "doubles")
    throw new TypeError("Invalid game mode");
  if (
    options.threePlayerAttackProhibited !== undefined &&
    typeof options.threePlayerAttackProhibited !== "boolean"
  ) {
    throw new TypeError("Invalid three-player attack setting");
  }
  const { board, nextPieceId } = createInitialBoard();
  return recordPosition({
    rulesVersion: 1,
    mode: options.mode,
    players: { south: ids[0], west: ids[1], north: ids[2], east: ids[3] },
    threePlayerAttackProhibited: options.threePlayerAttackProhibited ?? true,
    status: "playing",
    turn: "south",
    result: null,
    board,
    hands: emptyHands(),
    nextPieceId,
    eliminations: [],
    drawProposals: [],
    attackRelations: [],
    recaptureSquares: { south: [], west: [], north: [], east: [] },
    repetitions: {},
    moveNumber: 0,
    lastMove: null,
  });
}

export function setDrawProposal(
  state: FourShogiState,
  side: Side,
  proposed: boolean,
): SetDrawProposalResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  if (!getActiveSides(state).includes(side)) return { ok: false, reason: "already_eliminated" };
  if (state.turn !== side) return { ok: false, reason: "not_your_turn" };
  if (typeof proposed !== "boolean") return { ok: false, reason: "invalid_proposal" };
  if (state.drawProposals.includes(side) === proposed) return { ok: true, state };
  const drawProposals = sides.filter((entry) =>
    entry === side ? proposed : state.drawProposals.includes(entry),
  );
  return { ok: true, state: finishIfDrawAgreed({ ...state, drawProposals }) };
}

export function getLegalActionsForSide(state: FourShogiState, side: Side): FourShogiAction[] {
  if (state.status === "finished" || !getActiveSides(state).includes(side)) return [];
  return getLegalMovesWithAttacks(state, side, getOrdinaryMoves(state, side)).map(
    (move) => move.action,
  );
}

export function getLegalActions(state: FourShogiState): FourShogiAction[] {
  return state.status === "finished" ? [] : getLegalActionsForSide(state, state.turn);
}

/** Classifies ordinary moves without reading repetition history or changing the position. */
export function getActionAvailability(state: FourShogiState): {
  legalActions: FourShogiAction[];
  threePlayerAttackForbiddenActions: FourShogiAction[];
} {
  if (state.status === "finished" || !getActiveSides(state).includes(state.turn))
    return { legalActions: [], threePlayerAttackForbiddenActions: [] };
  const ordinary = getOrdinaryMoves(state, state.turn);
  const allowed = getLegalMovesWithAttacks(state, state.turn, ordinary);
  const allowedSet = new Set(allowed);
  return {
    legalActions: allowed.map((move) => move.action),
    threePlayerAttackForbiddenActions: ordinary
      .filter((move) => !allowedSet.has(move))
      .map((move) => move.action),
  };
}

export function applyAction(
  state: FourShogiState,
  side: Side,
  action: FourShogiAction,
  repetitionLookup?: RepetitionLookup,
): ApplyActionResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  if (!getActiveSides(state).includes(side)) return { ok: false, reason: "already_eliminated" };
  if (state.turn !== side) return { ok: false, reason: "not_your_turn" };
  if (!validActionShape(action)) return { ok: false, reason: "invalid_action" };
  const validated = validateOrdinaryAction(state, side, action);
  if (!validated.ok) return validated;
  if (requiresAttackFiltering(state, side)) {
    const allowed = getLegalMovesWithAttacks(state, side, getOrdinaryMoves(state, side));
    if (!allowed.some((move) => sameAction(move.action, action)))
      return { ok: false, reason: "three_player_attack" };
  }
  return applyLegalMove(state, side, validated.move, repetitionLookup);
}

function sameAction(left: FourShogiAction, right: FourShogiAction): boolean {
  if (left.type !== right.type || left.to.x !== right.to.x || left.to.y !== right.to.y)
    return false;
  return left.type === "movePiece" && right.type === "movePiece"
    ? left.from.x === right.from.x && left.from.y === right.from.y && left.promote === right.promote
    : left.type === "dropPiece" && right.type === "dropPiece" && left.pieceKind === right.pieceKind;
}

function validActionShape(action: FourShogiAction): boolean {
  if (action === null || typeof action !== "object") return false;
  return action.type === "movePiece"
    ? typeof action.promote === "boolean"
    : action.type === "dropPiece" && handPieceKinds.includes(action.pieceKind);
}

export function eliminateSide(
  state: FourShogiState,
  side: Side,
  reason: ExternalEliminationReason,
  repetitionLookup?: RepetitionLookup,
): EliminateSideResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  if (!getActiveSides(state).includes(side)) return { ok: false, reason: "already_eliminated" };
  if (!["resigned", "left", "timeout", "disconnected"].includes(reason))
    return { ok: false, reason: "invalid_reason" };
  if (reason === "resigned" && state.turn !== side) return { ok: false, reason: "not_your_turn" };
  const eliminated = eliminateBatch(state, [side], reason);
  const settled = settlePosition(eliminated, side, state.turn !== side, repetitionLookup);
  return {
    ok: true,
    state: settled,
    captured: null,
    eliminations: settled.eliminations.slice(state.eliminations.length),
  };
}

export { captureEliminatedHands, type EliminatedHands } from "./eliminatedHands";
