"""表示・時計から独立した、不変の完全ルール状態。"""

from dataclasses import dataclass
from typing import Literal

from .replay import Action, ExternalReason, HandPieceKind, InitialOptions, Position, Side

type PieceKind = Literal["king", "rook", "gold", "silver", "pawn"]
type EliminationReason = ExternalReason | Literal["checkmate", "no_legal_actions"]
type FinishReason = Literal["last_player", "no_survivors", "repetition", "agreement"]
type MoveError = Literal[
    "game_finished",
    "already_eliminated",
    "not_your_turn",
    "out_of_bounds",
    "no_piece",
    "not_your_piece",
    "friendly_piece",
    "king_capture",
    "invalid_movement",
    "invalid_promotion",
    "promotion_required",
    "occupied",
    "missing_hand_piece",
    "dead_end_pawn",
    "nifu",
    "dead_king_pawn_drop",
    "self_check",
    "pawn_drop_mate",
    "three_player_attack",
]
type AttackReason = Literal["check", "capture", "threat", "blockade"]

HAND_KINDS: tuple[HandPieceKind, ...] = ("rook", "gold", "silver", "pawn")


@dataclass(frozen=True, slots=True)
class Piece:
    id: int
    side: Side
    kind: PieceKind
    promoted: bool = False


type Board = tuple[tuple[Piece | None, ...], ...]


@dataclass(frozen=True, slots=True)
class Hand:
    rook: int = 0
    gold: int = 0
    silver: int = 0
    pawn: int = 0

    def count(self, kind: HandPieceKind) -> int:
        return (self.rook, self.gold, self.silver, self.pawn)[HAND_KINDS.index(kind)]


@dataclass(frozen=True, slots=True)
class Elimination:
    side: Side
    reason: EliminationReason
    group: int
    rank: int


@dataclass(frozen=True, slots=True)
class Standing:
    side: Side
    rank: int


@dataclass(frozen=True, slots=True)
class GameResult:
    reason: FinishReason
    standings: tuple[Standing, ...]


@dataclass(frozen=True, slots=True)
class AttackRelation:
    attacker: Side
    target: Side
    reasons: tuple[AttackReason, ...]
    target_piece_ids: tuple[int, ...]
    pending_sides: tuple[Side, ...]


@dataclass(frozen=True, slots=True)
class MoveRecord:
    side: Side
    action: Action
    piece: Piece
    captured: Piece | None


@dataclass(frozen=True, slots=True)
class State:
    initial: InitialOptions
    board: Board
    next_piece_id: int
    hands: tuple[Hand, ...] = (Hand(), Hand(), Hand(), Hand())
    status: Literal["playing", "finished"] = "playing"
    turn: Side | None = "south"
    result: GameResult | None = None
    eliminations: tuple[Elimination, ...] = ()
    draw_proposals: tuple[Side, ...] = ()
    attack_relations: tuple[AttackRelation, ...] = ()
    recapture_squares: tuple[tuple[Position, ...], ...] = ((), (), (), ())
    repetitions: tuple[tuple[str, int], ...] = ()
    move_number: int = 0
    last_move: MoveRecord | None = None


@dataclass(frozen=True, slots=True)
class TransitionSuccess:
    state: State
    captured: Piece | None = None
    eliminations: tuple[Elimination, ...] = ()
    ok: Literal[True] = True


@dataclass(frozen=True, slots=True)
class TransitionFailure:
    reason: MoveError
    ok: Literal[False] = False


type TransitionResult = TransitionSuccess | TransitionFailure
