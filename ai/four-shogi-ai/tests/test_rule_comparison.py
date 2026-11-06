import json
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from four_shogi_ai import (
    ActionEvent,
    DrawProposalEvent,
    EliminateEvent,
    ReplayInput,
    apply_event,
    create_initial_state,
    legal_actions,
    parse_replay,
    replay,
    replay_to_dict,
)
from four_shogi_ai.board import active_sides, pieces
from four_shogi_ai.replay import SIDES, Event
from scripts.rule_comparison import (
    ROOT,
    compare,
    evidence,
    first_difference,
    normalize_trace,
    python_trace,
    ts_traces,
)

from .rule_fixtures import OFF, move, repetition_input, repetition_json


def archived_input(name: str) -> dict[str, Any]:
    archive = json.loads((ROOT / "test-fixtures/matches" / name).read_text())
    initial = {**archive["detail"]["replay"]["initial"], "threePlayerAttackProhibited": False}
    return {
        "schemaVersion": 1,
        "ruleProfileId": "tetraboard-four-shogi-singles-v1",
        "rulesVersion": 1,
        "initial": initial,
        "events": archive["events"],
    }


@pytest.mark.parametrize(
    "name,reason,ranks",
    [
        ("shogi-singles.json", "last_player", [1, 2, 3, 4]),
        ("shogi-legacy.json", "last_player", [1, 2, 3, 4]),
        ("shogi-singles-draw.json", "agreement", [1, 1, 1, 1]),
    ],
)
def test_python_only_archive_replay(name: str, reason: str, ranks: list[int]) -> None:
    # 元fixtureはON。複製した入力だけをOFFへ変更し、元の保存棋譜は変更しません。
    # TSを起動せず、イベント列をPython単独で最後まで再生します。
    state = replay(parse_replay(archived_input(name)))
    assert state.result and state.result.reason == reason
    assert [s.rank for s in state.result.standings] == ranks
    assert legal_actions(state) == ()


def generated_sequence(seed: int, count: int) -> dict[str, object]:
    state = create_initial_state(OFF)
    events = []
    for _ in range(count):
        if state.status == "finished":
            break
        before = deepcopy(state)
        actions = legal_actions(state)
        assert actions and state.turn is not None
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF
        event = ActionEvent(state.turn, actions[seed % len(actions)])
        result = apply_event(state, event)
        assert result.ok
        assert state == before
        state = result.state
        events.append(event)
        ids = [p.id for p, _ in pieces(state.board)]
        assert len(ids) == len(set(ids)) and all(i < state.next_piece_id for i in ids)
        assert all(n >= 0 for h in state.hands for n in (h.rook, h.gold, h.silver, h.pawn))
        assert state.status == "finished" or state.turn in active_sides(state)
        assert state.move_number == len(events)
    return replay_to_dict(ReplayInput(OFF, tuple(events), len(events)))


def test_full_state_and_transitions_match_real_ts(tmp_path: Path) -> None:
    initial = create_initial_state(OFF)
    inputs = [
        archived_input(name)
        for name in ("shogi-singles.json", "shogi-legacy.json", "shogi-singles-draw.json")
    ]
    inputs += [repetition_json(), replay_to_dict(replace(repetition_input(), event_offset=31))]
    # 有効イベントに加え、手番違い・不正着手・脱落済み・終局後の拒否を照合します。
    event_sequences: list[tuple[Event, ...]] = [
        (ActionEvent("west", legal_actions(initial)[0]),),
        (ActionEvent("south", move("A9", "A8")),),
        (ActionEvent("south", move("E7", "E5")),),
        (DrawProposalEvent("west", True),),
        (EliminateEvent("west", "resigned"),),
        (DrawProposalEvent("south", True), DrawProposalEvent("south", False)),
        (EliminateEvent("west", "left"), EliminateEvent("west", "timeout")),
        tuple(EliminateEvent(s, "left") for s in SIDES[1:]) + (DrawProposalEvent("south", True),),
    ]
    inputs += [
        replay_to_dict(ReplayInput(OFF, tuple(events), len(events))) for events in event_sequences
    ]
    inputs += [generated_sequence(seed, 32) for seed in (7, 314159)]
    expected = ts_traces(inputs)
    assert len(expected) == len(inputs)
    for case, (input, ts) in enumerate(zip(inputs, expected, strict=True)):
        difference = compare(input, ts)
        if difference:
            artifact = tmp_path / f"rule-mismatch-{case}.json"
            artifact.write_text(
                json.dumps(evidence(input, difference), ensure_ascii=False, indent=2)
            )
            pytest.fail(f"{artifact}: {difference}")


@pytest.mark.parametrize(
    "field",
    [
        "turn",
        "repetitions",
        "drawProposals",
        "recaptureSquares",
        "legalActions",
        "captured",
        "eliminations",
    ],
)
def test_comparator_detects_semantic_differences(field: str) -> None:
    input = replay_to_dict(replace(repetition_input(), event_offset=1))
    reference = python_trace(input)
    changed = deepcopy(reference)
    if field == "legalActions":
        changed[1][field].pop()
    elif field == "turn":
        changed[1]["state"][field] = "east"
    elif field == "repetitions":
        key = next(iter(changed[1]["state"][field]))
        changed[1]["state"][field][key] += 1
    elif field == "drawProposals":
        changed[1]["state"][field] = ["south"]
    elif field == "recaptureSquares":
        changed[1]["state"][field]["south"] = [{"x": 0, "y": 0}]
    elif field == "captured":
        changed[1]["transition"][field] = {
            "id": 1,
            "side": "south",
            "kind": "king",
            "promoted": False,
        }
    else:
        changed[1]["transition"][field] = [
            {"side": "east", "reason": "left", "group": 1, "rank": 4}
        ]
    difference = compare(input, changed)
    assert difference and difference["eventIndex"] == 0 and field in difference["path"]


def test_comparator_ignores_enumeration_and_identity_numbers_not_history() -> None:
    original = python_trace(replay_to_dict(replace(repetition_input(), event_offset=1)))
    changed = deepcopy(original)
    for frame in changed:
        frame["legalActions"].reverse()
        state = frame["state"]
        for row in state["board"]:
            for p in row:
                if p:
                    p["id"] += 100
        state["nextPieceId"] += 100
        if state["lastMove"]:
            state["lastMove"]["piece"]["id"] += 100
        state["repetitions"] = {
            json.dumps(json.loads(k), indent=1): v for k, v in state["repetitions"].items()
        }
    assert first_difference(normalize_trace(original), normalize_trace(changed)) is None
    assert changed != original
