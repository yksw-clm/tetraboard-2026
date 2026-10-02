export const sides = ["south", "west", "north", "east"] as const;
export const handPieceKinds = ["rook", "gold", "silver", "pawn"] as const;
export type Side = (typeof sides)[number];
export type HandPieceKind = (typeof handPieceKinds)[number];
export type PieceKind = "king" | HandPieceKind;
export type Position = Readonly<{ x: number; y: number }>;
export type Piece = Readonly<{
  id: number;
  side: Side;
  kind: PieceKind;
  promoted: boolean;
}>;
export type Cell = Piece | null;
export type Board = readonly (readonly Cell[])[];
export type Hand = Readonly<Record<HandPieceKind, number>>;
export type Hands = Readonly<Record<Side, Hand>>;
export type GameMode = "singles" | "doubles";
export type Team = "south-north" | "west-east";
export type ExternalEliminationReason = "resigned" | "left" | "timeout" | "disconnected";
export type EliminationReason = ExternalEliminationReason | "checkmate" | "no_legal_actions";
export type Elimination = Readonly<{
  side: Side;
  reason: EliminationReason;
  rank: number | null;
  group: number;
}>;
export type AttackReason = "check" | "capture" | "threat" | "blockade";
export type AttackRelation = Readonly<{
  attacker: Side;
  target: Side;
  reasons: readonly AttackReason[];
  targetPieceIds: readonly number[];
  pendingSides: readonly Side[];
}>;
export type FourShogiAction =
  | Readonly<{ type: "movePiece"; from: Position; to: Position; promote: boolean }>
  | Readonly<{ type: "dropPiece"; pieceKind: HandPieceKind; to: Position }>;
export type MoveRecord = Readonly<{
  side: Side;
  action: FourShogiAction;
  piece: Piece;
  captured: Piece | null;
}>;
export type GameResult =
  | Readonly<{
      mode: "singles";
      reason: "last_player" | "no_survivors" | "repetition";
      standings: readonly Readonly<{ side: Side; rank: number }>[];
    }>
  | Readonly<{
      mode: "doubles";
      reason: "team_eliminated" | "simultaneous_mate" | "repetition";
      winner: Team | null;
    }>;
export type StateBase = Readonly<{
  rulesVersion: 1;
  mode: GameMode;
  players: Readonly<Record<Side, string>>;
  threePlayerAttackProhibited: boolean;
  board: Board;
  hands: Hands;
  eliminations: readonly Elimination[];
  attackRelations: readonly AttackRelation[];
  recaptureSquares: Readonly<Record<Side, readonly Position[]>>;
  repetitions: Readonly<Record<string, number>>;
  nextPieceId: number;
  moveNumber: number;
  lastMove: MoveRecord | null;
}>;
export type FourShogiState =
  | (StateBase & Readonly<{ status: "playing"; turn: Side; result: null }>)
  | (StateBase & Readonly<{ status: "finished"; turn: null; result: GameResult }>);
export type InitialStateOptions = Readonly<{
  mode: GameMode;
  players: Readonly<Record<Side, string>>;
  threePlayerAttackProhibited?: boolean;
}>;
export type MoveError =
  | "invalid_action"
  | "game_finished"
  | "not_your_turn"
  | "already_eliminated"
  | "out_of_bounds"
  | "no_piece"
  | "not_your_piece"
  | "occupied"
  | "friendly_piece"
  | "king_capture"
  | "invalid_movement"
  | "invalid_promotion"
  | "promotion_required"
  | "missing_hand_piece"
  | "dead_end_pawn"
  | "nifu"
  | "pawn_drop_mate"
  | "dead_king_pawn_drop"
  | "self_check"
  | "three_player_attack";
export type TransitionSuccess = Readonly<{
  ok: true;
  state: FourShogiState;
  captured: Piece | null;
  eliminations: readonly Elimination[];
}>;
export type ApplyActionResult = TransitionSuccess | Readonly<{ ok: false; reason: MoveError }>;
export type EliminateSideResult =
  | TransitionSuccess
  | Readonly<{
      ok: false;
      reason: "game_finished" | "already_eliminated" | "not_your_turn" | "invalid_reason";
    }>;

export function getActiveSides(state: FourShogiState): Side[] {
  return sides.filter((side) => !state.eliminations.some((entry) => entry.side === side));
}

export function teamForSide(side: Side): Team {
  return side === "south" || side === "north" ? "south-north" : "west-east";
}

export function areEnemies(mode: GameMode, left: Side, right: Side): boolean {
  return left !== right && (mode === "singles" || teamForSide(left) !== teamForSide(right));
}

export function usesAttackRestriction(state: FourShogiState): boolean {
  return (
    state.threePlayerAttackProhibited &&
    state.mode === "singles" &&
    getActiveSides(state).length === 4
  );
}
