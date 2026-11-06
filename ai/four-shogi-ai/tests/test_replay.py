import copy
import json
import subprocess
from collections.abc import Sequence
from dataclasses import FrozenInstanceError
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from four_shogi_ai import ReplayInputError, parse_replay, replay_to_dict


def example(prohibited: bool = True) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "ruleProfileId": "tetraboard-four-shogi-singles-v1",
        "rulesVersion": 1,
        "initial": {
            "mode": "singles",
            "players": {"south": "s", "west": "w", "north": "n", "east": "e"},
            "threePlayerAttackProhibited": prohibited,
        },
        "events": [],
    }


def with_events(events: Sequence[object], prohibited: bool = True) -> dict[str, Any]:
    raw = example(prohibited)
    raw["events"] = [{"index": index, "event": event} for index, event in enumerate(events)]
    return raw


EVENTS: list[dict[str, Any]] = [
    {
        "type": "action",
        "side": "south",
        "action": {
            "type": "movePiece",
            "from": {"x": 4, "y": 6},
            "to": {"x": 4, "y": 5},
            "promote": False,
        },
    },
    *[
        {"type": "eliminate", "side": "west", "reason": reason}
        for reason in ("resigned", "left", "timeout", "disconnected")
    ],
    *[
        {"type": "drawProposal", "side": "north", "proposed": proposed}
        for proposed in (True, False)
    ],
    *[
        {
            "type": "action",
            "side": "east",
            "action": {"type": "dropPiece", "pieceKind": kind, "to": {"x": 0, "y": 8}},
        }
        for kind in ("rook", "gold", "silver", "pawn")
    ],
]


@pytest.mark.parametrize("prohibited", [False, True])
@pytest.mark.parametrize("event", EVENTS)
def test_round_trip_preserves_all_event_variants(event: dict[str, Any], prohibited: bool) -> None:
    raw = with_events([event], prohibited)
    expected = {**copy.deepcopy(raw), "eventOffset": 1}

    actual = replay_to_dict(parse_replay(raw))

    assert actual == expected
    assert "eventOffset" not in raw


def test_offset_counts_events_and_preserves_unapplied_suffix() -> None:
    raw = with_events(EVENTS)
    raw["eventOffset"] = 2

    replay = parse_replay(raw)

    assert replay.event_offset == 2
    assert len(replay.events) == len(EVENTS)
    assert replay_to_dict(replay) == raw


def test_input_and_serialized_output_cannot_mutate_parsed_data() -> None:
    raw = with_events(copy.deepcopy(EVENTS[:1]))
    replay = parse_replay(raw)
    expected = replay_to_dict(replay)

    raw["initial"]["players"]["south"] = "changed"
    raw["events"][0]["event"]["action"]["to"]["x"] = 8
    exported = replay_to_dict(replay)
    exported["events"] = []

    assert replay_to_dict(replay) == expected
    with pytest.raises(FrozenInstanceError):
        replay.event_offset = 999  # type: ignore[misc]  # 実行時の変更拒否も確認します。


def invalid_examples() -> list[tuple[object, str, int | None]]:
    cases: list[tuple[object, str, int | None]] = []
    for field, value, code in [
        ("schemaVersion", True, "unsupported_version"),
        ("rulesVersion", 2, "unsupported_version"),
        ("ruleProfileId", "unknown", "unsupported_profile"),
        ("eventOffset", -1, "invalid_offset"),
        ("eventOffset", 1, "invalid_offset"),
        ("eventOffset", False, "invalid_offset"),
        ("events", {}, "invalid_input"),
        ("extra", "ignored?", "invalid_input"),
    ]:
        raw = example()
        raw[field] = value
        cases.append((raw, code, None))
    for field in example():
        raw = example()
        del raw[field]
        cases.append((raw, "invalid_input", None))
    for field, value, code in [
        ("mode", "doubles", "unsupported_mode"),
        ("threePlayerAttackProhibited", 1, "invalid_input"),
        ("players", {"south": "s", "west": "s", "north": "n", "east": "e"}, "invalid_input"),
        ("players", {"south": [], "west": "w", "north": "n", "east": "e"}, "invalid_input"),
    ]:
        raw = example()
        raw["initial"][field] = value
        cases.append((raw, code, None))
    for event in [
        {"type": "drawProposal", "side": "south", "proposed": 1},
        {"type": "drawProposal", "side": "invalid", "proposed": True},
        {"type": "eliminate", "side": "south", "reason": "checkmate"},
        {"type": "action", "side": "south", "action": {"type": "pass"}},
        {"type": "drawProposal", "side": "south", "proposed": True, "extra": 0},
    ]:
        cases.append((with_events([event]), "invalid_input", 0))
    for coordinate in [True, -1, 9, 0.5, "1", None, 2**53]:
        raw = with_events(copy.deepcopy(EVENTS[:1]))
        raw["events"][0]["event"]["action"]["to"]["x"] = coordinate
        cases.append((raw, "invalid_input", 0))
    for index in [True, 1, -1, 0.5]:
        raw = with_events(EVENTS[:1])
        raw["events"][0]["index"] = index
        cases.append((raw, "non_contiguous_events", 0))
    raw = with_events(EVENTS[:1] + [{"type": "unknown"}])
    raw["eventOffset"] = 0
    cases.append((raw, "invalid_input", 1))
    invalid_roots: list[object] = [None, [], "replay", 1]
    cases.extend((value, "invalid_input", None) for value in invalid_roots)
    return cases


@pytest.mark.parametrize(("raw", "code", "event_index"), invalid_examples())
def test_rejects_invalid_contract_without_mutation(
    raw: object, code: str, event_index: int | None
) -> None:
    original = copy.deepcopy(raw)

    with pytest.raises(ReplayInputError) as error:
        parse_replay(raw)

    assert error.value.code == code
    assert error.value.event_index == event_index
    assert raw == original


def test_contract_matches_real_ts_validator() -> None:
    inputs: list[object] = [example(False), example(True), with_events(EVENTS)]
    numeric = with_events(copy.deepcopy(EVENTS[:1]))
    numeric["schemaVersion"] = 1.0
    numeric["events"][0]["index"] = 0.0
    numeric["events"][0]["event"]["action"]["to"]["x"] = 4.0
    inputs.append(numeric)
    inputs.extend(raw for raw, _, _ in invalid_examples())
    expected: list[dict[str, object]] = []
    for raw in inputs:
        try:
            expected.append({"ok": True, "replay": replay_to_dict(parse_replay(raw))})
        except ReplayInputError as error:
            expected.append({"ok": False, "code": error.code, "eventIndex": error.event_index})
    root = Path(__file__).resolve().parents[3]

    result = subprocess.run(
        ["bun", "scripts/ci/validateAiReplay.ts"],
        input=json.dumps(inputs),
        text=True,
        capture_output=True,
        cwd=root,
        check=True,
        timeout=30,
    )

    assert json.loads(result.stdout) == expected


@settings(derandomize=True, max_examples=100)
@given(
    x=st.integers(min_value=0, max_value=8),
    y=st.integers(min_value=0, max_value=8),
    side=st.sampled_from(["south", "west", "north", "east"]),
    promote=st.booleans(),
    prohibited=st.booleans(),
)
def test_generated_contract_round_trip(
    x: int, y: int, side: str, promote: bool, prohibited: bool
) -> None:
    raw = with_events(
        [
            {
                "type": "action",
                "side": side,
                "action": {
                    "type": "movePiece",
                    "from": {"x": 0, "y": 8},
                    "to": {"x": x, "y": y},
                    "promote": promote,
                },
            }
        ],
        prohibited,
    )

    actual = replay_to_dict(parse_replay(raw))

    assert actual == {**raw, "eventOffset": 1}
