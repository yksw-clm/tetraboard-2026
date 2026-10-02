import {
  attacksSquare,
  forwardForSide,
  inBounds,
  inPromotionZone,
  isFinalRank,
  isInCheck,
  pieces,
} from "./board";
import {
  areEnemies,
  getActiveSides,
  handPieceKinds,
  type FourShogiAction,
  type FourShogiState,
  type MoveError,
  type Piece,
  type Position,
  type Side,
} from "./types";

export type OrdinaryMove = {
  action: FourShogiAction;
  state: FourShogiState;
  piece: Piece;
  captured: Piece | null;
};
type Validation = { ok: true; move: OrdinaryMove } | { ok: false; reason: MoveError };

function promotionPossible(piece: Piece, from: Position, to: Position): boolean {
  return (
    !piece.promoted &&
    (piece.kind === "rook" || piece.kind === "silver" || piece.kind === "pawn") &&
    (inPromotionZone(piece.side, from) || inPromotionZone(piece.side, to))
  );
}

function validate(
  state: FourShogiState,
  side: Side,
  action: FourShogiAction,
  checkPawnDropMate: boolean,
): Validation {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  const active = getActiveSides(state);
  if (!active.includes(side)) return { ok: false, reason: "already_eliminated" };
  if (!inBounds(action.to)) return { ok: false, reason: "out_of_bounds" };
  const captured = state.board[action.to.y][action.to.x];
  let piece: Piece;
  let nextPieceId = state.nextPieceId;
  let hands = state.hands;

  if (action.type === "movePiece") {
    if (!inBounds(action.from)) return { ok: false, reason: "out_of_bounds" };
    const original = state.board[action.from.y][action.from.x];
    if (original === null) return { ok: false, reason: "no_piece" };
    if (original.side !== side) return { ok: false, reason: "not_your_piece" };
    if (captured?.side === side) return { ok: false, reason: "friendly_piece" };
    if (captured?.kind === "king") return { ok: false, reason: "king_capture" };
    if (
      captured &&
      active.includes(captured.side) &&
      !areEnemies(state.mode, side, captured.side)
    ) {
      return { ok: false, reason: "friendly_piece" };
    }
    if (!attacksSquare(state.board, original, action.from, action.to)) {
      return { ok: false, reason: "invalid_movement" };
    }
    if (action.promote && !promotionPossible(original, action.from, action.to)) {
      return { ok: false, reason: "invalid_promotion" };
    }
    if (
      original.kind === "pawn" &&
      !original.promoted &&
      isFinalRank(side, action.to) &&
      !action.promote
    ) {
      return { ok: false, reason: "promotion_required" };
    }
    piece = { ...original, promoted: original.promoted || action.promote };
    if (captured !== null) {
      hands = {
        ...hands,
        [side]: { ...hands[side], [captured.kind]: hands[side][captured.kind] + 1 },
      };
    }
  } else {
    if (captured !== null) return { ok: false, reason: "occupied" };
    if (!handPieceKinds.includes(action.pieceKind) || state.hands[side][action.pieceKind] <= 0) {
      return { ok: false, reason: "missing_hand_piece" };
    }
    if (action.pieceKind === "pawn") {
      if (isFinalRank(side, action.to)) return { ok: false, reason: "dead_end_pawn" };
      const vertical = side === "south" || side === "north";
      if (
        pieces(state.board).some(
          ({ piece: pawn, position }) =>
            pawn.side === side &&
            pawn.kind === "pawn" &&
            !pawn.promoted &&
            (vertical ? position.x === action.to.x : position.y === action.to.y),
        )
      )
        return { ok: false, reason: "nifu" };
      const forward = forwardForSide(side);
      const ahead = { x: action.to.x + forward.x, y: action.to.y + forward.y };
      const blockedKing = inBounds(ahead) ? state.board[ahead.y][ahead.x] : null;
      if (blockedKing?.kind === "king" && !active.includes(blockedKing.side)) {
        return { ok: false, reason: "dead_king_pawn_drop" };
      }
    }
    piece = { id: nextPieceId++, side, kind: action.pieceKind, promoted: false };
    hands = {
      ...hands,
      [side]: { ...hands[side], [action.pieceKind]: hands[side][action.pieceKind] - 1 },
    };
  }

  const board = state.board.map((row) => [...row]);
  if (action.type === "movePiece") board[action.from.y][action.from.x] = null;
  board[action.to.y][action.to.x] = piece;
  const candidate: FourShogiState = { ...state, board, hands, nextPieceId };
  if (isInCheck(candidate, side)) return { ok: false, reason: "self_check" };
  if (checkPawnDropMate && action.type === "dropPiece" && action.pieceKind === "pawn") {
    const forward = forwardForSide(side);
    const ahead = { x: action.to.x + forward.x, y: action.to.y + forward.y };
    const king = inBounds(ahead) ? board[ahead.y][ahead.x] : null;
    if (
      king?.kind === "king" &&
      active.includes(king.side) &&
      areEnemies(state.mode, side, king.side) &&
      !hasPawnCheckResponse(candidate, king.side, action.to)
    ) {
      return { ok: false, reason: "pawn_drop_mate" };
    }
  }
  return { ok: true, move: { action, state: candidate, piece, captured } };
}

function* moveActions(piece: Piece, from: Position, to: Position): Generator<FourShogiAction> {
  yield { type: "movePiece", from, to, promote: false };
  if (promotionPossible(piece, from, to)) yield { type: "movePiece", from, to, promote: true };
}

function hasPawnCheckResponse(state: FourShogiState, side: Side, pawn: Position): boolean {
  // 隣接する歩の王手は合駒で遮れないため、王の移動または歩の捕獲だけを調べます。
  for (const { piece, position: from } of pieces(state.board)) {
    if (piece.side !== side) continue;
    if (piece.kind === "king") {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const to = { x: from.x + dx, y: from.y + dy };
          if (validate(state, side, { type: "movePiece", from, to, promote: false }, false).ok)
            return true;
        }
      }
    } else {
      for (const action of moveActions(piece, from, pawn)) {
        if (validate(state, side, action, false).ok) return true;
      }
    }
  }
  return false;
}

function* ordinaryMoves(state: FourShogiState, side: Side): Generator<OrdinaryMove> {
  if (state.status === "finished" || !getActiveSides(state).includes(side)) return;
  for (const { piece, position: from } of pieces(state.board)) {
    if (piece.side !== side) continue;
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const to = { x, y };
        if (!attacksSquare(state.board, piece, from, to)) continue;
        for (const action of moveActions(piece, from, to)) {
          const result = validate(state, side, action, true);
          if (result.ok) yield result.move;
        }
      }
    }
  }
  for (const pieceKind of handPieceKinds) {
    if (state.hands[side][pieceKind] <= 0) continue;
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const result = validate(state, side, { type: "dropPiece", pieceKind, to: { x, y } }, true);
        if (result.ok) yield result.move;
      }
    }
  }
}

export function validateOrdinaryAction(
  state: FourShogiState,
  side: Side,
  action: FourShogiAction,
): Validation {
  return validate(state, side, action, true);
}

export function getOrdinaryMoves(state: FourShogiState, side: Side): OrdinaryMove[] {
  return [...ordinaryMoves(state, side)];
}

export function hasOrdinaryMove(state: FourShogiState, side: Side): boolean {
  return !ordinaryMoves(state, side).next().done;
}
