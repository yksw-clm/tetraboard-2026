export const sides = ["south", "north"] as const;
export const handPieceKinds = [
  "rook",
  "bishop",
  "gold",
  "silver",
  "knight",
  "lance",
  "pawn",
] as const;
export type Side = (typeof sides)[number];
export type HandPieceKind = (typeof handPieceKinds)[number];
export type PieceKind = "king" | HandPieceKind;
export type Position = Readonly<{ x: number; y: number }>;
export type Piece = Readonly<{ id: number; side: Side; kind: PieceKind; promoted: boolean }>;
export type Cell = Piece | null;
export type Board = readonly (readonly Cell[])[];
export type Hand = Readonly<Record<HandPieceKind, number>>;
export type Hands = Readonly<Record<Side, Hand>>;
export type ShogiAction =
  | Readonly<{ type: "movePiece"; from: Position; to: Position; promote: boolean }>
  | Readonly<{ type: "dropPiece"; pieceKind: HandPieceKind; to: Position }>;
export type ExternalEliminationReason = "resigned" | "left" | "timeout" | "disconnected";
export type EliminationReason =
  | ExternalEliminationReason
  | "checkmate"
  | "no_legal_actions"
  | "perpetual_check"
  | "impasse"
  | "invalid_declaration";
export type Elimination = Readonly<{ side: Side; reason: EliminationReason; rank: 2; group: 0 }>;
export type GameResult = Readonly<{
  winner: Side | null;
  reason: EliminationReason | "repetition" | "impasse" | "declaration" | "move_limit";
}>;
export type MoveRecord = Readonly<{
  side: Side;
  action: ShogiAction;
  piece: Piece;
  captured: Piece | null;
}>;
export type NonChecks = Readonly<Record<Side, number>>;
export type RepetitionEntry = Readonly<{ count: number; nonChecks: NonChecks }>;
export type RepetitionLookup = (key: string) => RepetitionEntry | undefined;
export type StateBase = Readonly<{
  rulesVersion: 1;
  players: Readonly<Record<Side, string>>;
  board: Board;
  hands: Hands;
  eliminations: readonly Elimination[];
  drawProposals: readonly Side[];
  nextPieceId: number;
  moveNumber: number;
  lastMove: MoveRecord | null;
  repetitions: Readonly<Record<string, RepetitionEntry>>;
  nonChecks: NonChecks;
}>;
export type ShogiState =
  | (StateBase & Readonly<{ status: "playing"; turn: Side; result: null }>)
  | (StateBase & Readonly<{ status: "finished"; turn: null; result: GameResult }>);
export type InitialStateOptions = Readonly<{ players: Readonly<Record<Side, string>> }>;
export type MoveError =
  | "invalid_action"
  | "game_finished"
  | "not_your_turn"
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
  | "dead_end_piece"
  | "nifu"
  | "pawn_drop_mate"
  | "self_check"
  | "invalid_proposal"
  | "impasse_unavailable";
export type TransitionSuccess = Readonly<{
  ok: true;
  state: ShogiState;
  captured: Piece | null;
  eliminations: readonly Elimination[];
}>;
export type ApplyActionResult = TransitionSuccess | Readonly<{ ok: false; reason: MoveError }>;
export const otherSide = (side: Side): Side => (side === "south" ? "north" : "south");
export function getActiveSides(state: ShogiState): Side[] {
  return sides.filter((side) => !state.eliminations.some((e) => e.side === side));
}
