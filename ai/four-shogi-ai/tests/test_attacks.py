from copy import deepcopy
from dataclasses import replace

import pytest

from four_shogi_ai import (
    ActionEvent,
    DrawProposalEvent,
    DropAction,
    EliminateEvent,
    apply_event,
    legal_actions,
)
from four_shogi_ai.engine import position_key, record_position
from four_shogi_ai.replay import SIDES, Side
from four_shogi_ai.state import (
    AttackReason,
    AttackRelation,
    Elimination,
    Hand,
    PieceKind,
    State,
    TransitionFailure,
)

from .rule_fixtures import fixture, move, pos
from .test_rules import act, success


def attack(
    attacker: Side,
    target: Side,
    reasons: tuple[AttackReason, ...] = ("check",),
    ids: tuple[int, ...] = (),
    pending: tuple[Side, ...] | None = None,
) -> AttackRelation:
    return AttackRelation(
        attacker,
        target,
        reasons,
        ids,
        pending if pending is not None else tuple(s for s in SIDES if s != attacker),
    )


TWO = (attack("north", "west"), attack("east", "west"))


def on(state: State, relations: tuple[AttackRelation, ...] = ()) -> State:
    return record_position(
        replace(
            state,
            initial=replace(state.initial, three_player_attack_prohibited=True),
            attack_relations=relations,
            repetitions=(),
        )
    )


def relation(
    state: State, attacker: Side = "south", target: Side = "west"
) -> AttackRelation | None:
    return next(
        (r for r in state.attack_relations if r.attacker == attacker and r.target == target), None
    )


def reasons(
    state: State, attacker: Side = "south", target: Side = "west"
) -> tuple[AttackReason, ...]:
    r = relation(state, attacker, target)
    return r.reasons if r else ()


TARGETS: tuple[tuple[PieceKind, str, bool], ...] = (
    ("pawn", "A1", False),
    ("pawn", "F1", True),
    ("pawn", "F1", False),
    ("gold", "A1", True),
    ("gold", "A1", False),
    ("rook", "A1", False),
)
ATTACKERS: tuple[tuple[PieceKind, bool, str, tuple[bool, ...]], ...] = (
    ("pawn", False, "D5", (False, True, True, True, True, True)),
    ("pawn", True, "C5", (False, True, True, True, True, True)),
    ("gold", False, "C5", (False, False, True, True, True, True)),
    ("silver", False, "C5", (False, False, True, True, True, True)),
    ("silver", True, "C5", (False, False, True, True, True, True)),
    ("rook", False, "B4", (False, False, True, False, True, True)),
    ("rook", True, "B4", (False, False, True, False, True, True)),
    ("king", False, "B5", (False, False, False, False, False, False)),
)


@pytest.mark.parametrize("kind,promoted,origin,expected", ATTACKERS)
@pytest.mark.parametrize("column", range(6))
def test_threat_table(
    kind: PieceKind, promoted: bool, origin: str, expected: tuple[bool, ...], column: int
) -> None:
    target_kind, king, defended = TARGETS[column]
    entries: tuple[tuple[Side, PieceKind, str, bool], ...] = (
        () if kind == "king" else (("south", kind, origin, promoted),)
    )
    entries += (("west", target_kind, "D3", False),)
    if defended:
        entries += (("west", "gold", "E3", False),)
    kings: dict[Side, str] = {"west": king}
    if kind == "king":
        kings["south"] = origin
    state = on(fixture(entries, kings=kings))
    result = act(state, move(origin, "C4" if kind == "king" else "D4"))
    target = state.board[2][3]
    assert target
    r = relation(result.state)
    assert bool(r and target.id in r.target_piece_ids) == expected[column]


@pytest.mark.parametrize(
    "kind,promoted",
    [
        ("pawn", False),
        ("pawn", True),
        ("gold", False),
        ("silver", False),
        ("silver", True),
        ("rook", False),
        ("rook", True),
    ],
)
def test_capture_classification(kind: PieceKind, promoted: bool) -> None:
    state = on(fixture((("south", "pawn", "D4", False), ("west", kind, "D3", promoted))))
    result = act(state, move("D4", "D3"))
    assert ("capture" in reasons(result.state)) == (kind != "pawn")
    assert result.state.recapture_squares[1] == (pos("D3"),)


def test_king_capture_is_exempt_from_capture_classification() -> None:
    state = on(fixture((("west", "gold", "D3", False),), kings={"south": "C4"}))
    assert "capture" not in reasons(act(state, move("C4", "D3")).state)


@pytest.mark.parametrize(
    "kind,promoted", [("pawn", True), ("silver", False), ("silver", True), ("rook", True)]
)
def test_promoted_targets_use_original_kind_column(kind: PieceKind, promoted: bool) -> None:
    state = on(
        fixture(
            (("south", "pawn", "D5", False), ("west", kind, "D3", promoted)), kings={"west": "F1"}
        )
    )
    r = relation(act(state, move("D5", "D4")).state)
    assert r and r.target_piece_ids == (6,)


@pytest.mark.parametrize(
    "third_party,origin,to,expected",
    [
        (False, "D3", "E3", "check"),
        (True, "E4", "D4", "check"),
        (True, "D4", "C4", "blockade"),
    ],
)
def test_check_and_blockade_are_attributed_to_mover(
    third_party: bool, origin: str, to: str, expected: AttackReason
) -> None:
    entries: tuple[tuple[Side, PieceKind, str, bool], ...] = (
        (
            ("north", "rook", "E6" if expected == "check" else "D6", False),
            ("south", "gold", origin, False),
        )
        if third_party
        else (("south", "rook", origin, False),)
    )
    state = on(fixture(entries, kings={"west": "E1"}))
    result = act(state, move(origin, to)).state
    assert expected in reasons(result)
    assert relation(result, "north", "west") is None


def test_third_party_discovered_threat_is_not_movers_threat() -> None:
    state = on(
        fixture(
            (
                ("north", "rook", "D6", False),
                ("south", "gold", "D4", False),
                ("west", "gold", "D2", False),
            )
        )
    )
    assert "threat" not in reasons(act(state, move("D4", "C4")).state)


@pytest.mark.parametrize("occupant", ["west", "north"])
def test_blockade_excludes_targets_own_occupied_squares(occupant: Side) -> None:
    state = on(fixture((("south", "rook", "C4", False), (occupant, "pawn", "B2", False))))
    assert ("blockade" in reasons(act(state, move("C4", "B4")).state)) == (occupant != "west")


def test_new_blockade_counts_already_attacked_squares_but_not_maintained_piece() -> None:
    state = on(
        fixture(
            (
                ("south", "rook", "C4", False),
                ("north", "pawn", "B2", False),
                ("east", "gold", "C3", False),
            )
        )
    )
    assert "blockade" in reasons(act(state, move("C4", "B4")).state)
    maintained = on(fixture((("south", "rook", "D3", False),), kings={"west": "E1"}), TWO)
    assert "blockade" not in reasons(act(maintained, move("D3", "F3")).state)


def test_maintained_threat_and_same_target_exemption_before_expiry() -> None:
    maintained = on(fixture((("south", "rook", "D6", False), ("west", "gold", "D3", False))))
    assert "threat" not in reasons(act(maintained, move("D6", "D4")).state)
    for pending in (("south", "west", "east"), ("south",)):
        state = on(
            fixture((("south", "pawn", "D5", False), ("west", "gold", "D3", False))),
            (attack("north", "west", ("threat",), (6,), pending),),
        )
        result = act(state, move("D5", "D4")).state
        assert relation(result) is None
        if pending == ("south",):
            assert result.attack_relations == ()


def test_same_target_exemption_does_not_cover_capture_or_replacement_identity() -> None:
    history = (attack("north", "west", ("threat",), (6,)), attack("east", "west"))
    state = on(fixture((("south", "pawn", "D4", False), ("west", "gold", "D3", False))), history)
    assert apply_event(state, ActionEvent("south", move("D4", "D3"))) == TransitionFailure(
        "three_player_attack"
    )
    replacement = on(
        fixture((("south", "pawn", "D5", False), ("west", "gold", "D3", False))),
        (attack("north", "west", ("threat",), (999,)), attack("east", "west")),
    )
    assert apply_event(replacement, ActionEvent("south", move("D5", "D4"))) == TransitionFailure(
        "three_player_attack"
    )


def test_rejection_preserves_history_and_recapture_opportunity() -> None:
    state = on(fixture((("south", "pawn", "D5", False), ("west", "gold", "D3", False))), TWO)
    state = replace(state, recapture_squares=((pos("F6"),), (), (), ()))
    before = deepcopy(state)
    assert move("D5", "D4") not in legal_actions(state)
    assert apply_event(state, ActionEvent("south", move("D5", "D4"))) == TransitionFailure(
        "three_player_attack"
    )
    assert apply_event(state, ActionEvent("south", move("D5", "E4"))) == TransitionFailure(
        "invalid_movement"
    )
    assert state == before


def test_response_to_check_exempts_all_targets_but_preserves_previous_relations() -> None:
    state = on(
        fixture(
            (
                ("west", "rook", "E1", False),
                ("west", "gold", "F7", False),
                ("south", "gold", "D8", False),
            ),
            kings={"south": "E9", "north": "I3"},
        ),
        TWO + (attack("south", "north", pending=("east",)),),
    )
    result = act(state, move("D8", "E8")).state
    assert tuple(r for r in result.attack_relations if r.attacker == "south") == (
        attack("south", "north", pending=("east",)),
    )


@pytest.mark.parametrize("capturer", ["west", "east"])
def test_recapture_exempts_any_capturer_at_any_eligible_square(capturer: Side) -> None:
    attackers: tuple[Side, Side] = ("north", "east") if capturer == "west" else ("west", "north")
    state = on(
        fixture((("south", "pawn", "D4", False), (capturer, "gold", "D3", False))),
        tuple(attack(a, capturer) for a in attackers),
    )
    state = replace(state, recapture_squares=((pos("F6"), pos("D3")), (), (), ()))
    result = act(state, move("D4", "D3")).state
    assert not any(r.attacker == "south" for r in result.attack_relations)
    assert result.recapture_squares[0] == ()
    assert result.recapture_squares[SIDES.index(capturer)] == (pos("D3"),)


def test_declining_recapture_consumes_exemption_on_own_move_only() -> None:
    state = on(fixture((("south", "pawn", "D4", False), ("west", "gold", "D3", False))), TWO)
    state = replace(state, recapture_squares=((pos("D3"),), (), (), ()))
    proposed = success(apply_event(state, DrawProposalEvent("south", True))).state
    assert (
        proposed.recapture_squares == state.recapture_squares
        and proposed.attack_relations == state.attack_relations
    )
    assert proposed.repetitions == state.repetitions
    result = act(proposed, move("A9", "B9")).state
    assert result.recapture_squares[0] == ()
    assert apply_event(
        replace(result, turn="south"), ActionEvent("south", move("D4", "D3"))
    ) == TransitionFailure("three_player_attack")


def test_history_expires_only_after_each_other_side_moves() -> None:
    state = on(fixture(turn="west"), (attack("south", "west"),))
    for origin, to, remaining in (
        ("A1", "B1", ("north", "east")),
        ("I1", "H1", ("east",)),
        ("I9", "H9", ()),
    ):
        state = act(state, move(origin, to)).state
        r = relation(state)
        assert (r.pending_sides if r else ()) == remaining
    assert relation(state) is None


def test_check_skips_do_not_count_as_actions_and_nonattack_keeps_own_relation() -> None:
    state = on(
        fixture(
            (("south", "rook", "E4", False), ("north", "pawn", "I2", False)), kings={"east": "I5"}
        ),
        (attack("west", "north"),),
    )
    first = act(state, move("E4", "I4")).state
    assert first.turn == "east"
    r = relation(first, "west", "north")
    assert r and r.pending_sides == ("north", "east")
    second = act(first, move("I5", "H5")).state
    r = relation(second, "west", "north")
    assert r and r.pending_sides == ("north",)
    quiet = on(fixture(), (attack("south", "west", pending=("east",)),))
    assert relation(act(quiet, move("A9", "B9")).state) == quiet.attack_relations[0]


def test_attacking_piece_capture_keeps_relation_and_reattack_resets_it() -> None:
    state = on(
        fixture((("south", "pawn", "D4", False), ("west", "gold", "D3", False)), turn="west"),
        (attack("south", "west", ("threat",), (6,)),),
    )
    r = relation(act(state, move("D3", "D4")).state)
    assert r and r.pending_sides == ("north", "east")
    reset = on(
        replace(state, turn="south"),
        (attack("south", "west", ("check", "threat"), (999,), ("east",)),),
    )
    assert relation(act(reset, move("D4", "D3")).state) == attack("south", "west", ("capture",))


def test_forced_attack_exception_is_per_target() -> None:
    entries: tuple[tuple[Side, PieceKind, str, bool], ...] = (
        ("south", "pawn", "A8", False),
        ("south", "pawn", "B8", False),
        ("south", "pawn", "B9", False),
        ("west", "gold", "A7", False),
        ("west", "gold", "B7", False),
    )
    state = on(fixture(entries), TWO)
    assert set(legal_actions(state)) == {move("A8", "A7"), move("B8", "B7")}
    other = on(
        fixture(entries + (("north", "gold", "A6", False),)),
        TWO + (attack("west", "north"), attack("east", "north")),
    )
    assert apply_event(other, ActionEvent("south", move("A8", "A7"))) == TransitionFailure(
        "three_player_attack"
    )
    assert move("B8", "B7") in legal_actions(other)


def test_one_move_mate_exempts_only_the_restricted_target() -> None:
    state = on(
        fixture(
            (
                ("south", "rook", "D3", False),
                ("south", "rook", "F3", False),
                ("south", "silver", "E3", False),
                ("south", "rook", "G2", False),
            ),
            kings={"west": "E1"},
        ),
        TWO,
    )
    result = act(state, move("G2", "E2"))
    assert any(e.side == "west" and e.reason == "checkmate" for e in result.eliminations)
    assert result.state.attack_relations == () and result.state.recapture_squares == (
        (),
        (),
        (),
        (),
    )
    other = on(
        fixture(
            (
                ("south", "pawn", "E4", False),
                ("west", "silver", "E3", False),
                ("south", "rook", "D4", False),
                ("south", "rook", "F4", False),
                ("south", "rook", "E5", False),
                ("south", "gold", "D1", False),
            ),
            kings={"north": "E2"},
        ),
        TWO,
    )
    assert apply_event(other, ActionEvent("south", move("E4", "E3"))) == TransitionFailure(
        "three_player_attack"
    )


def test_defense_is_geometric_and_evaluated_after_the_move() -> None:
    pinned = on(
        fixture(
            (
                ("south", "rook", "C6", False),
                ("south", "rook", "E1", False),
                ("west", "gold", "D5", False),
                ("west", "gold", "E5", False),
            ),
            kings={"west": "E9"},
        )
    )
    assert "threat" not in reasons(act(pinned, move("C6", "D6")).state)
    blocked = on(
        fixture(
            (("west", "gold", "D4", False), ("west", "rook", "G4", False)),
            hands={"south": Hand(rook=1)},
        )
    )
    r = relation(act(blocked, DropAction("rook", pos("E4"))).state)
    assert r and 5 in r.target_piece_ids


def test_repetition_includes_active_history_and_uses_piece_correspondence() -> None:
    state = on(
        fixture((("north", "silver", "E5", False),)),
        (attack("west", "north", ("threat", "capture"), (5, 999)),),
    )
    state = replace(state, recapture_squares=((), (), (), (pos("C4"), pos("F6"))))
    renamed = replace(
        state,
        board=tuple(
            tuple(replace(p, id=p.id + 100) if p else None for p in row) for row in state.board
        ),
        next_piece_id=state.next_piece_id + 100,
        attack_relations=(
            attack("west", "north", ("capture", "threat"), (105, 888), ("east", "north", "south")),
        ),
        recapture_squares=((), (), (), (pos("F6"), pos("C4"), pos("C4"))),
    )
    assert position_key(state) == position_key(renamed)
    assert legal_actions(state) == legal_actions(renamed)
    for changed in (
        replace(state, attack_relations=()),
        replace(state, recapture_squares=((), (), (), ())),
        replace(
            state, attack_relations=(replace(state.attack_relations[0], pending_sides=("south",)),)
        ),
        replace(state, attack_relations=(replace(state.attack_relations[0], target_piece_ids=()),)),
        replace(state, attack_relations=(replace(state.attack_relations[0], reasons=("check",)),)),
    ):
        assert position_key(state) != position_key(changed)
    assert (
        act(state, move("A9", "B9")).state.repetitions
        == act(renamed, move("A9", "B9")).state.repetitions
    )


def test_off_or_eliminated_ignores_history_and_external_elimination_clears_it() -> None:
    state = on(fixture((("south", "pawn", "D5", False), ("west", "gold", "D3", False))), TWO)
    for variant in (
        replace(state, initial=replace(state.initial, three_player_attack_prohibited=False)),
        replace(state, eliminations=(Elimination("east", "left", 1, 4),)),
    ):
        cleared = replace(variant, attack_relations=(), recapture_squares=((), (), (), ()))
        assert position_key(variant) == position_key(cleared)
        assert legal_actions(variant) == legal_actions(cleared)
        assert act(variant, move("D5", "D4")).state.attack_relations == ()
    ended = success(apply_event(state, EliminateEvent("east", "timeout"))).state
    assert ended.attack_relations == () and ended.recapture_squares == ((), (), (), ())
    assert move("D5", "D4") in legal_actions(ended)


def test_prohibition_uses_history_before_its_last_pending_action() -> None:
    state = on(
        fixture((("south", "pawn", "D5", False), ("west", "gold", "D3", False))),
        tuple(replace(r, pending_sides=("south",)) for r in TWO),
    )
    assert apply_event(state, ActionEvent("south", move("D5", "D4"))) == TransitionFailure(
        "three_player_attack"
    )
    quiet = act(state, move("A9", "B9")).state
    assert quiet.attack_relations == ()


def test_attack_restriction_can_eliminate_selected_side_without_ordinary_checkmate() -> None:
    state = on(
        fixture(
            (
                ("south", "pawn", "A8", False),
                ("south", "pawn", "B8", False),
                ("south", "pawn", "B9", False),
                ("west", "gold", "A7", False),
                ("west", "gold", "B7", False),
                ("north", "gold", "A6", False),
                ("east", "gold", "B6", False),
            ),
            turn="east",
        ),
        TWO
        + (
            attack("west", "north"),
            attack("east", "north"),
            attack("west", "east"),
            attack("north", "east"),
        ),
    )
    assert legal_actions(replace(state, turn="south")) == ()
    ordinary = replace(
        state, turn="south", initial=replace(state.initial, three_player_attack_prohibited=False)
    )
    assert set(legal_actions(ordinary)) == {move("A8", "A7"), move("B8", "B7")}
    result = act(state, move("I9", "H9"))
    assert [(e.side, e.reason, e.rank) for e in result.eliminations] == [
        ("south", "no_legal_actions", 4)
    ]
    assert result.state.turn == "west" and result.state.attack_relations == ()
