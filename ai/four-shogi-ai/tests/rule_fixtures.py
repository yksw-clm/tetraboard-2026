"""難しい境界を直接構築するテスト専用局面。公開の状態入力ではありません。"""

from dataclasses import replace

from four_shogi_ai import InitialOptions, MoveAction, Position, create_initial_state
from four_shogi_ai.engine import record_position
from four_shogi_ai.replay import SIDES, ActionEvent, ReplayInput, Side, replay_to_dict
from four_shogi_ai.state import Hand, Piece, PieceKind, State

OFF = InitialOptions(("s", "w", "n", "e"), False)


def pos(square: str) -> Position:
    return Position(ord(square[0]) - ord("A"), int(square[1:]) - 1)


def move(origin: str, to: str, promote: bool = False) -> MoveAction:
    return MoveAction(pos(origin), pos(to), promote)


def fixture(
    entries: tuple[tuple[Side, PieceKind, str, bool], ...] = (),
    *,
    kings: dict[Side, str] | None = None,
    turn: Side = "south",
    hands: dict[Side, Hand] | None = None,
) -> State:
    king_positions: dict[Side, str] = {"south": "A9", "west": "A1", "north": "I1", "east": "I9"}
    king_positions.update(kings or {})
    board: list[list[Piece | None]] = [[None] * 9 for _ in range(9)]
    all_entries: tuple[tuple[Side, PieceKind, str, bool], ...] = (
        tuple((s, "king", king_positions[s], False) for s in SIDES) + entries
    )
    for identity, (side, kind, at, promoted) in enumerate(all_entries, 1):
        p = pos(at)
        assert board[p.y][p.x] is None, at
        board[p.y][p.x] = Piece(identity, side, kind, promoted)
    state = replace(
        create_initial_state(OFF),
        board=tuple(tuple(row) for row in board),
        next_piece_id=len(all_entries) + 1,
        turn=turn,
        repetitions=(),
        hands=tuple((hands or {}).get(s, Hand()) for s in SIDES),
    )
    return record_position(state)


def repetition_input() -> ReplayInput:
    setup: tuple[tuple[Side, str, str], ...] = (
        ("south", "D8", "D7"),
        ("west", "B4", "C4"),
        ("north", "D2", "D3"),
        ("east", "H4", "G4"),
        ("south", "F8", "F7"),
        ("west", "B6", "C6"),
        ("north", "F2", "F3"),
        ("east", "H6", "G6"),
    )
    cycle: tuple[tuple[Side, str, str], ...] = (
        ("south", "D9", "D8"),
        ("west", "A4", "B4"),
        ("north", "D1", "D2"),
        ("east", "I4", "H4"),
        ("south", "D8", "D9"),
        ("west", "B4", "A4"),
        ("north", "D2", "D1"),
        ("east", "H4", "I4"),
    )
    events = tuple(ActionEvent(s, move(a, b)) for s, a, b in setup + cycle * 3)
    return ReplayInput(OFF, events, len(events))


def repetition_json() -> dict[str, object]:
    return replay_to_dict(repetition_input())
