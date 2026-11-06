from copy import deepcopy
from dataclasses import FrozenInstanceError, replace
from typing import cast

import pytest

from four_shogi_ai import (
    ActionEvent,
    DrawProposalEvent,
    DropAction,
    EliminateEvent,
    ReplayExecutionError,
    ReplayInput,
    apply_event,
    create_initial_state,
    legal_actions,
    replay,
)
from four_shogi_ai.board import active_sides, attacks_square, is_in_check, pieces
from four_shogi_ai.engine import eliminate_batch, position_key, settle
from four_shogi_ai.replay import SIDES, Action, ExternalReason, Side
from four_shogi_ai.state import (
    Hand,
    MoveError,
    Piece,
    PieceKind,
    State,
    TransitionFailure,
    TransitionResult,
    TransitionSuccess,
)

from .rule_fixtures import OFF, fixture, move, pos, repetition_input


def success(result: TransitionResult) -> TransitionSuccess:
    assert result.ok, result
    return result


def act(state: State, action: Action, side: Side | None = None) -> TransitionSuccess:
    actual = side or state.turn
    assert actual is not None
    return success(apply_event(state, ActionEvent(actual, action)))


def test_initial_and_all_legal_actions_are_independent() -> None:
    state = create_initial_state(OFF)
    before = deepcopy(state)
    assert len(tuple(pieces(state.board))) == 36
    assert len({p.id for p, _ in pieces(state.board)}) == 36
    assert state.turn == "south" and state.next_piece_id == 37
    assert tuple(count for _, count in state.repetitions) == (1,)
    assert all(hand == Hand() for hand in state.hands)
    for side, at in zip(SIDES, ("E9", "A5", "E1", "I5"), strict=True):
        p = state.board[pos(at).y][pos(at).x]
        assert p and p.kind == "king" and p.side == side
    actions = legal_actions(state)
    assert actions and actions == legal_actions(state)
    for action in actions:
        result = act(state, action)
        assert result.state.move_number == 1
        assert result.state is not state
    assert state == before
    with pytest.raises(FrozenInstanceError):
        setattr(state, "turn", "west")  # noqa: B010


def test_on_is_explicitly_unsupported_at_every_rule_entry() -> None:
    on = replace(OFF, three_player_attack_prohibited=True)
    with pytest.raises(NotImplementedError):
        create_initial_state(on)
    with pytest.raises(NotImplementedError):
        replay(ReplayInput(on, (), 0))
    state = replace(create_initial_state(OFF), initial=on)
    with pytest.raises(NotImplementedError):
        legal_actions(state)
    with pytest.raises(NotImplementedError):
        apply_event(state, EliminateEvent("south", "resigned"))


@pytest.mark.parametrize("side", SIDES)
@pytest.mark.parametrize(
    "kind,promoted,expected",
    [
        ("king", False, {(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)}),
        ("gold", False, {(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (0, 1)}),
        ("silver", False, {(-1, -1), (0, -1), (1, -1), (-1, 1), (1, 1)}),
        ("pawn", False, {(0, -1)}),
        ("silver", True, {(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (0, 1)}),
        ("pawn", True, {(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (0, 1)}),
    ],
)
def test_step_moves_in_all_four_directions(
    side: Side, kind: PieceKind, promoted: bool, expected: set[tuple[int, int]]
) -> None:
    origin = pos("E5")
    rotated = set()
    for dx, dy in expected:
        for _ in range(SIDES.index(side)):
            dx, dy = -dy, dx
        rotated.add((dx, dy))
    board = fixture().board
    actual = {
        (dx, dy)
        for dx in range(-2, 3)
        for dy in range(-2, 3)
        if attacks_square(
            board, Piece(10, side, kind, promoted), origin, replace(origin, x=4 + dx, y=4 + dy)
        )
    }
    assert actual == rotated


def test_rook_obstacles_and_promoted_diagonal() -> None:
    state = fixture((("south", "rook", "E5", True), ("west", "silver", "E3", False)))
    actions = legal_actions(state)
    assert move("E5", "E3") in actions
    assert move("E5", "E2") not in actions
    assert move("E5", "F4") in actions
    assert move("E5", "G3") not in actions


@pytest.mark.parametrize(
    "side,origin,to",
    [
        ("south", "D2", "D1"),
        ("west", "H4", "I4"),
        ("north", "F8", "F9"),
        ("east", "B6", "A6"),
    ],
)
def test_forced_promotion(side: Side, origin: str, to: str) -> None:
    state = fixture(((side, "pawn", origin, False),), turn=side)
    assert apply_event(state, ActionEvent(side, move(origin, to))) == TransitionFailure(
        "promotion_required"
    )
    result = act(state, move(origin, to, True))
    assert result.state.last_move and result.state.last_move.piece.promoted
    assert result.state.last_move.piece.id == 5


@pytest.mark.parametrize("origin,to", [("E4", "E3"), ("E3", "E4"), ("E3", "E2")])
def test_optional_promotion_enter_leave_inside(origin: str, to: str) -> None:
    state = fixture((("south", "rook", origin, False),))
    assert move(origin, to) in legal_actions(state)
    assert move(origin, to, True) in legal_actions(state)


def test_capture_demotes_and_drop_uses_fresh_identity() -> None:
    state = fixture((("south", "rook", "E7", False), ("west", "silver", "E5", True)))
    dead = success(apply_event(state, EliminateEvent("west", "timeout"))).state
    taken = act(dead, move("E7", "E5"))
    assert taken.captured and taken.captured.id == 6 and taken.captured.promoted
    assert taken.state.hands[0].silver == 1
    # テスト専用局面で次の自手番を作り、再利用ではなく新IDで打つことを確認します。
    dropped = act(replace(taken.state, turn="south"), DropAction("silver", pos("D5")))
    p = dropped.state.board[4][3]
    assert p and p.id == state.next_piece_id and p.side == "south" and not p.promoted
    assert dropped.state.hands[0].silver == 0


@pytest.mark.parametrize(
    "action,reason",
    [
        (move("E5", "J5"), "out_of_bounds"),
        (move("B8", "B7"), "no_piece"),
        (move("E3", "E4"), "not_your_piece"),
        (move("E5", "D4"), "invalid_movement"),
        (move("E5", "E4", True), "invalid_promotion"),
        (move("A9", "B8", True), "invalid_promotion"),
        (DropAction("silver", pos("D5")), "missing_hand_piece"),
        (DropAction("pawn", pos("E5")), "occupied"),
        (DropAction("pawn", pos("D1")), "dead_end_pawn"),
        (DropAction("pawn", pos("F4")), "nifu"),
    ],
)
def test_rejections_leave_every_field_unchanged(action: Action, reason: str) -> None:
    state = fixture(
        (
            ("south", "rook", "E5", False),
            ("west", "silver", "E3", False),
            ("south", "pawn", "F6", False),
        ),
        hands={"south": Hand(pawn=1)},
    )
    before = deepcopy(state)
    result = apply_event(state, ActionEvent("south", action))
    assert not result.ok and result.reason == reason
    assert state == before
    assert action not in legal_actions(state)


def test_self_check_and_pinned_enemy_attacks() -> None:
    pinned = fixture(
        (("west", "rook", "E1", False), ("south", "silver", "E5", False)),
        kings={"south": "E9", "north": "H1"},
    )
    assert apply_event(pinned, ActionEvent("south", move("E5", "F4"))) == TransitionFailure(
        "self_check"
    )
    # 西銀は南飛車と西王の間でピンされていても、E4へ利きを持ちます。
    state = fixture(
        (("south", "rook", "A5", False), ("west", "silver", "D5", False)),
        kings={"south": "E3", "west": "H5"},
    )
    assert apply_event(state, ActionEvent("south", move("E3", "E4"))) == TransitionFailure(
        "self_check"
    )


def test_pawn_drop_mate_and_legal_pawn_advance() -> None:
    state = fixture(
        (
            ("south", "gold", "E3", False),
            ("north", "pawn", "D1", False),
            ("north", "pawn", "F1", False),
            ("north", "pawn", "D2", False),
            ("north", "pawn", "F2", False),
        ),
        kings={"north": "E1"},
        hands={"south": Hand(pawn=1)},
    )
    assert apply_event(
        state, ActionEvent("south", DropAction("pawn", pos("E2")))
    ) == TransitionFailure("pawn_drop_mate")
    escapable = fixture(kings={"north": "E1"}, hands={"south": Hand(pawn=1)})
    assert act(escapable, DropAction("pawn", pos("E2"))).state.turn == "north"
    advancement = fixture(
        (
            ("south", "pawn", "E3", False),
            ("south", "gold", "D3", False),
            ("south", "gold", "F3", False),
            ("north", "pawn", "D1", False),
            ("north", "pawn", "F1", False),
        ),
        kings={"north": "E1"},
    )
    result = act(advancement, move("E3", "E2"))
    assert [(e.side, e.reason) for e in result.eliminations] == [("north", "checkmate")]


def test_pawn_drop_response_can_capture_with_other_piece() -> None:
    state = fixture(
        (
            ("south", "gold", "E3", False),
            ("north", "gold", "D2", False),
            ("north", "pawn", "D1", False),
            ("north", "pawn", "F1", False),
            ("north", "pawn", "F2", False),
        ),
        kings={"north": "E1"},
        hands={"south": Hand(pawn=1)},
    )
    result = act(state, DropAction("pawn", pos("E2")))
    assert legal_actions(result.state) == (move("D2", "E2"),)


def test_dead_king_blocks_capture_passage_and_pawn_drop() -> None:
    state = fixture(
        (("south", "rook", "E7", False),), kings={"west": "E3"}, hands={"south": Hand(pawn=1)}
    )
    dead = success(apply_event(state, EliminateEvent("west", "left"))).state
    for action, reason in [
        (move("E7", "E3"), "king_capture"),
        (move("E7", "E2"), "invalid_movement"),
        (DropAction("pawn", pos("E4")), "dead_king_pawn_drop"),
    ]:
        assert apply_event(dead, ActionEvent("south", cast(Action, action))) == TransitionFailure(
            cast(MoveError, reason)
        )
    assert act(dead, DropAction("pawn", pos("D4"))).ok


def test_check_priority_is_recomputed_after_each_action() -> None:
    state = fixture((("south", "rook", "F5", False),), kings={"west": "D1", "north": "H1"})
    first = act(state, move("F5", "F1")).state
    assert first.turn == "west" and is_in_check(first, "north")
    second = act(first, move("D1", "D2")).state
    assert second.turn == "north" and not is_in_check(second, "west")


def test_discovered_check_by_third_party_skips_turn() -> None:
    state = fixture(
        (("west", "rook", "E1", False), ("south", "gold", "E3", False)), kings={"north": "E5"}
    )
    result = act(state, move("E3", "F3"))
    assert result.state.turn == "north" and result.eliminations == ()


def test_simultaneous_mates_keep_same_group_and_tied_ranks() -> None:
    state = fixture(
        (
            ("south", "rook", "E2", False),
            ("south", "gold", "B3", False),
            ("south", "gold", "H3", False),
            ("west", "rook", "G1", False),
            ("south", "pawn", "F1", True),
        ),
        kings={"south": "E9"},
    )
    result = act(state, move("E2", "E1"))
    assert [(e.side, e.group, e.rank, e.reason) for e in result.eliminations] == [
        ("west", 1, 3, "checkmate"),
        ("north", 1, 3, "checkmate"),
    ]
    assert result.state.turn == "east" and result.state.hands[1] == Hand()
    assert result.state.board[0][0] == state.board[0][0]
    end = success(apply_event(result.state, EliminateEvent("east", "left"))).state
    assert end.result and end.result.reason == "last_player"
    assert [(s.side, s.rank) for s in end.result.standings] == [
        ("south", 1),
        ("east", 2),
        ("west", 3),
        ("north", 3),
    ]


def test_no_legal_moves_eliminates_only_selected_side() -> None:
    state = fixture(
        (
            ("south", "gold", "B3", False),
            ("south", "gold", "C2", False),
            ("south", "pawn", "F6", False),
        )
    )
    assert not is_in_check(state, "west")
    assert legal_actions(replace(state, turn="west")) == ()
    assert state.eliminations == ()
    result = act(state, move("F6", "F5"))
    assert [(e.side, e.reason, e.rank) for e in result.eliminations] == [
        ("west", "no_legal_actions", 4)
    ]
    assert result.state.turn == "north"


@pytest.mark.parametrize("reason", ["resigned", "left", "timeout", "disconnected"])
def test_external_elimination(reason: ExternalReason) -> None:
    state = fixture(
        (("west", "silver", "E5", True),),
        turn="west" if reason == "resigned" else "south",
        hands={"west": Hand(rook=2, pawn=3)},
    )
    result = success(apply_event(state, EliminateEvent("west", reason)))
    assert result.state.turn == ("north" if reason == "resigned" else "south")
    assert result.state.hands[1] == Hand() and result.state.board == state.board
    assert (
        result.state.move_number == state.move_number and result.state.last_move == state.last_move
    )
    assert sum(c for _, c in result.state.repetitions) == 2
    assert apply_event(result.state, EliminateEvent("west", reason)) == TransitionFailure(
        "already_eliminated"
    )


def test_draw_proposals_preserve_rule_history_and_agree_after_elimination() -> None:
    state = create_initial_state(OFF)
    proposed = success(apply_event(state, DrawProposalEvent("south", True))).state
    assert proposed == replace(state, draw_proposals=("south",))
    assert success(apply_event(proposed, DrawProposalEvent("south", True))).state == proposed
    assert success(apply_event(proposed, DrawProposalEvent("south", False))).state == state
    assert apply_event(proposed, DrawProposalEvent("west", True)) == TransitionFailure(
        "not_your_turn"
    )
    for side in ("west", "north"):
        proposed = success(apply_event(proposed, EliminateEvent(side, "left"))).state
    proposed = act(proposed, legal_actions(proposed)[0]).state
    assert proposed.turn == "east"
    ended = success(apply_event(proposed, DrawProposalEvent("east", True))).state
    assert ended.result and ended.result.reason == "agreement"
    assert [(s.side, s.rank) for s in ended.result.standings] == [
        ("south", 1),
        ("east", 1),
        ("north", 3),
        ("west", 4),
    ]
    assert ended.repetitions == proposed.repetitions
    # 脱落で未同意者が消えた場合も、通常の勝敗確定より後に合意を判定します。
    two_agreed = replace(state, draw_proposals=("south", "west", "north"))
    agreed = success(apply_event(two_agreed, EliminateEvent("east", "disconnected"))).state
    assert agreed.result and agreed.result.reason == "agreement"


def test_replay_repetition_offset_and_error_index() -> None:
    input = repetition_input()
    before = replay(replace(input, event_offset=31))
    assert before.status == "playing" and max(c for _, c in before.repetitions) == 3
    end = replay(input)
    assert end.result and end.result.reason == "repetition"
    assert [s.rank for s in end.result.standings] == [1, 1, 1, 1]
    assert end.move_number == 32 and legal_actions(end) == () and end.turn is None
    assert max(c for _, c in end.repetitions) == 4
    assert replay(replace(input, event_offset=0)) == create_initial_state(OFF)
    invalid = replace(
        input, events=input.events + (EliminateEvent("south", "left"),), event_offset=33
    )
    with pytest.raises(ReplayExecutionError) as caught:
        replay(invalid)
    assert caught.value.code == "event_rejected"
    assert caught.value.event_index == 32 and caught.value.reason == "game_finished"
    assert replay(replace(invalid, event_offset=32)) == end


def test_no_survivors_and_terminal_priorities() -> None:
    # 一括脱落が生存者を残さない場合の結果契約を、進行層の境界で確認します。
    state = settle(eliminate_batch(create_initial_state(OFF), SIDES, "checkmate"), "south")
    assert state.result and state.result.reason == "no_survivors"
    assert [s.rank for s in state.result.standings] == [1, 1, 1, 1]
    assert state.turn is None and legal_actions(state) == ()
    terminal = create_initial_state(OFF)
    for side in ("west", "north", "east"):
        terminal = success(apply_event(terminal, EliminateEvent(side, "left"))).state
    assert terminal.result and terminal.result.reason == "last_player"
    assert apply_event(terminal, DrawProposalEvent("south", True)) == TransitionFailure(
        "game_finished"
    )
    assert apply_event(
        create_initial_state(OFF), EliminateEvent("west", "resigned")
    ) == TransitionFailure("not_your_turn")


def test_position_key_ignores_ids_clockless_metadata_and_proposals() -> None:
    state = create_initial_state(OFF)
    renamed = replace(
        state,
        board=tuple(
            tuple(replace(p, id=p.id + 100) if p else None for p in row) for row in state.board
        ),
        next_piece_id=137,
        move_number=99,
        draw_proposals=("south",),
    )
    assert position_key(state) == position_key(renamed)
    assert position_key(state) != position_key(replace(state, turn="west"))
    assert active_sides(state) == SIDES


def test_mating_east_does_not_make_east_the_turn_origin() -> None:
    state = fixture(
        (
            ("south", "rook", "I5", False),
            ("south", "gold", "I7", False),
            ("south", "gold", "H8", False),
        ),
        kings={"north": "E1"},
    )
    result = act(state, move("I7", "H7"))
    assert [(e.side, e.reason) for e in result.eliminations] == [("east", "checkmate")]
    assert result.state.turn == "west"


def test_pawn_advance_before_dead_king_is_allowed() -> None:
    state = fixture((("south", "pawn", "E5", False),), kings={"west": "E3"})
    state = success(apply_event(state, EliminateEvent("west", "left"))).state
    assert act(state, move("E5", "E4")).state.board[3][4] is not None


@pytest.mark.parametrize("side", SIDES)
def test_nifu_uses_own_forward_file_and_ignores_promoted_or_enemy_pawns(side: Side) -> None:
    def rotate(square: str) -> str:
        p = pos(square)
        x, y = p.x, p.y
        for _ in range(SIDES.index(side)):
            x, y = 8 - y, x
        return f"{chr(ord('A') + x)}{y + 1}"

    square, destination = rotate("E6"), rotate("E4")
    state = fixture(((side, "pawn", square, False),), turn=side, hands={side: Hand(pawn=1)})
    action = DropAction("pawn", pos(destination))
    assert apply_event(state, ActionEvent(side, action)) == TransitionFailure("nifu")
    promoted = fixture(((side, "pawn", square, True),), turn=side, hands={side: Hand(pawn=1)})
    assert act(promoted, action).ok
    opponent = SIDES[(SIDES.index(side) + 1) % 4]
    other = fixture(((opponent, "pawn", square, False),), turn=side, hands={side: Hand(pawn=1)})
    assert act(other, action).ok


def test_ordinary_victory_precedes_agreement_and_repetition() -> None:
    state = create_initial_state(OFF)
    for side in ("west", "north"):
        state = success(apply_event(state, EliminateEvent(side, "left"))).state
    state = success(apply_event(state, DrawProposalEvent("south", True))).state
    before_counts = state.repetitions
    result = success(apply_event(state, EliminateEvent("east", "timeout"))).state
    assert result.result and result.result.reason == "last_player"
    assert result.repetitions == before_counts


def test_legal_move_results_conserve_pieces_except_discarded_hands() -> None:
    state = fixture(
        (("south", "rook", "E5", False), ("west", "gold", "E3", False)),
        hands={"south": Hand(silver=1)},
    )
    assert move("E5", "A5") in legal_actions(state)
    before = deepcopy(state)
    for action in legal_actions(state):
        result = act(state, action)
        assert (
            len(tuple(pieces(result.state.board)))
            + sum(h.rook + h.gold + h.silver + h.pawn for h in result.state.hands)
            == 7
        )
    assert state == before
