"""完全状態の逐次比較。CLIは不一致の再現情報をJSONへ保存します。"""

import argparse
import json
import subprocess
from dataclasses import asdict
from pathlib import Path
from typing import Any, cast

from four_shogi_ai import (
    apply_event,
    create_initial_state,
    legal_actions,
    parse_replay,
    replay_to_dict,
)
from four_shogi_ai.replay import SIDES, Action, ActionEvent, ReplayInput
from four_shogi_ai.state import State

ROOT = Path(__file__).resolve().parents[3]
COMPARATOR_VERSION = 1


def action_dict(action: Action, replay_input: ReplayInput) -> object:
    encoded = replay_to_dict(ReplayInput(replay_input.initial, (ActionEvent("south", action),), 1))
    events = cast(list[dict[str, Any]], encoded["events"])
    return events[0]["event"]["action"]


def state_dict(state: State) -> dict[str, Any]:
    # JSON化は開発ツールの責務。公開の状態インポート契約は設けません。
    initial = state.initial
    move = state.last_move
    return {
        "rulesVersion": 1,
        "mode": "singles",
        "players": dict(zip(SIDES, initial.players, strict=True)),
        "threePlayerAttackProhibited": initial.three_player_attack_prohibited,
        "board": [[asdict(p) if p else None for p in row] for row in state.board],
        "hands": {s: asdict(h) for s, h in zip(SIDES, state.hands, strict=True)},
        "nextPieceId": state.next_piece_id,
        "status": state.status,
        "turn": state.turn,
        "result": None if state.result is None else {"mode": "singles", **asdict(state.result)},
        "eliminations": [asdict(e) for e in state.eliminations],
        "drawProposals": list(state.draw_proposals),
        "attackRelations": [
            {
                "attacker": r.attacker,
                "target": r.target,
                "reasons": list(r.reasons),
                "targetPieceIds": list(r.target_piece_ids),
                "pendingSides": list(r.pending_sides),
            }
            for r in state.attack_relations
        ],
        "recaptureSquares": {
            s: [asdict(p) for p in squares]
            for s, squares in zip(SIDES, state.recapture_squares, strict=True)
        },
        "repetitions": dict(state.repetitions),
        "moveNumber": state.move_number,
        "lastMove": None
        if move is None
        else {
            "side": move.side,
            "action": action_dict(move.action, ReplayInput(initial, (), 0)),
            "piece": asdict(move.piece),
            "captured": asdict(move.captured) if move.captured else None,
        },
    }


def python_trace(input: dict[str, Any]) -> list[dict[str, Any]]:
    parsed = parse_replay(input)
    state = create_initial_state(parsed.initial)
    frames: list[dict[str, Any]] = []

    def append(transition: object) -> None:
        frames.append(
            {
                "state": state_dict(state),
                "legalActions": [action_dict(a, parsed) for a in legal_actions(state)],
                "transition": transition,
            }
        )

    append(None)
    for event in parsed.events[: parsed.event_offset]:
        result = apply_event(state, event)
        if result.ok:
            state = result.state
            append(
                {
                    "ok": True,
                    "captured": asdict(result.captured) if result.captured else None,
                    "eliminations": [asdict(e) for e in result.eliminations],
                }
            )
        else:
            append({"ok": False, "reason": result.reason})
            break
    return frames


def ts_traces(inputs: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    result = subprocess.run(
        ["bun", "run", str(ROOT / "scripts/ci/compareAiRules.ts")],
        input=json.dumps(inputs),
        text=True,
        capture_output=True,
        check=True,
        cwd=ROOT,
        timeout=60,
    )
    value: list[list[dict[str, Any]]] = json.loads(result.stdout)
    return value


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def normalize_trace(trace: list[dict[str, Any]]) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = json.loads(json.dumps(trace))
    identities: dict[int, int] = {}
    for frame in frames:
        state = frame["state"]
        board_pieces = [p for row in state["board"] for p in row if p is not None]
        ids = [p["id"] for p in board_pieces]
        if len(ids) != len(set(ids)) or any(i >= state["nextPieceId"] for i in ids):
            raise ValueError("駒IDの重複または次のIDとの不整合")
        for p in board_pieces:
            identities.setdefault(p["id"], len(identities) + 1)
        # 初期配置はマス順、打ち駒は出現順で同一性を対応付けます。捕獲後も対応を保持します。
        for p in board_pieces:
            p["id"] = identities[p["id"]]
        if state["lastMove"]:
            for key in ("piece", "captured"):
                p = state["lastMove"][key]
                if p:
                    p["id"] = identities[p["id"]]
        transition = frame["transition"]
        if transition and transition.get("captured"):
            p = transition["captured"]
            p["id"] = identities[p["id"]]
        for relation in state["attackRelations"]:
            relation["targetPieceIds"] = sorted(identities[i] for i in relation["targetPieceIds"])
        state["nextPieceId"] = len(identities) + 1
        state["repetitions"] = {
            canonical(json.loads(key)): count for key, count in state["repetitions"].items()
        }
        frame["legalActions"] = sorted(frame["legalActions"], key=canonical)
    return frames


def first_difference(left: Any, right: Any, path: str = "$") -> dict[str, Any] | None:
    if type(left) is not type(right):
        return {"path": path, "python": left, "typescript": right}
    if isinstance(left, dict):
        if left.keys() != right.keys():
            return {"path": path, "python": sorted(left), "typescript": sorted(right)}
        for key in sorted(left):
            diff = first_difference(left[key], right[key], f"{path}.{key}")
            if diff:
                return diff
    elif isinstance(left, list):
        if len(left) != len(right):
            return {"path": f"{path}.length", "python": len(left), "typescript": len(right)}
        for i, (a, b) in enumerate(zip(left, right, strict=True)):
            diff = first_difference(a, b, f"{path}[{i}]")
            if diff:
                return diff
    elif left != right:
        return {"path": path, "python": left, "typescript": right}
    return None


def compare(input: dict[str, Any], ts: list[dict[str, Any]]) -> dict[str, Any] | None:
    py_frames, ts_frames = normalize_trace(python_trace(input)), normalize_trace(ts)
    for frame, (py, other) in enumerate(zip(py_frames, ts_frames, strict=False)):
        diff = first_difference(py, other)
        if diff:
            return {"eventIndex": frame - 1 if frame else None, **diff}
    if len(py_frames) != len(ts_frames):
        return {
            "eventIndex": min(len(py_frames), len(ts_frames)) - 1,
            "path": "$.frames.length",
            "python": len(py_frames),
            "typescript": len(ts_frames),
        }
    return None


def evidence(input: dict[str, Any], difference: dict[str, Any] | None) -> dict[str, Any]:
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, capture_output=True, check=True
    ).stdout.strip()
    dirty = bool(
        subprocess.run(
            ["git", "status", "--porcelain"], cwd=ROOT, text=True, capture_output=True, check=True
        ).stdout
    )
    return {
        "comparatorVersion": COMPARATOR_VERSION,
        "pythonCommit": revision,
        "typescriptCommit": revision,
        "workingTreeDirty": dirty,
        "schemaVersion": input["schemaVersion"],
        "rulesVersion": input["rulesVersion"],
        "input": input,
        "difference": difference,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    input = json.loads(args.input.read_text())
    ts = ts_traces([input])[0]
    diff = compare(input, ts)
    args.output.write_text(json.dumps(evidence(input, diff), ensure_ascii=False, indent=2) + "\n")
    print("一致" if diff is None else canonical(diff))
    raise SystemExit(0 if diff is None else 1)


if __name__ == "__main__":
    main()
