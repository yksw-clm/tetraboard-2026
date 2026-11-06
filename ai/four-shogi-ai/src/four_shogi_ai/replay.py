"""版付き再生入力を検証します。イベントの合法性や終局は判定しません。"""

from dataclasses import dataclass
from typing import Literal, cast

type Side = Literal["south", "west", "north", "east"]
type HandPieceKind = Literal["rook", "gold", "silver", "pawn"]
type ExternalReason = Literal["resigned", "left", "timeout", "disconnected"]
type ErrorCode = Literal[
    "invalid_input",
    "unsupported_version",
    "unsupported_profile",
    "unsupported_mode",
    "non_contiguous_events",
    "invalid_offset",
]
SIDES: tuple[Side, ...] = ("south", "west", "north", "east")
RULE_PROFILE_ID = "tetraboard-four-shogi-singles-v1"


class ReplayInputError(ValueError):
    def __init__(self, code: ErrorCode, message: str, event_index: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.event_index = event_index


@dataclass(frozen=True, slots=True)
class Position:
    x: int
    y: int


@dataclass(frozen=True, slots=True)
class MoveAction:
    from_position: Position
    to: Position
    promote: bool


@dataclass(frozen=True, slots=True)
class DropAction:
    piece_kind: HandPieceKind
    to: Position


type Action = MoveAction | DropAction


@dataclass(frozen=True, slots=True)
class ActionEvent:
    side: Side
    action: Action


@dataclass(frozen=True, slots=True)
class EliminateEvent:
    side: Side
    reason: ExternalReason


@dataclass(frozen=True, slots=True)
class DrawProposalEvent:
    side: Side
    proposed: bool


type Event = ActionEvent | EliminateEvent | DrawProposalEvent


@dataclass(frozen=True, slots=True)
class InitialOptions:
    # 方向順を固定し、外部の可変dictをルールへ持ち込みません。
    players: tuple[str, str, str, str]
    three_player_attack_prohibited: bool


@dataclass(frozen=True, slots=True)
class ReplayInput:
    initial: InitialOptions
    events: tuple[Event, ...]
    event_offset: int


def _record(value: object, keys: set[str], optional: set[str] | None = None) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ReplayInputError("invalid_input", "JSONオブジェクトが必要です")
    if set(value) - keys or (keys - (optional or set())) - set(value):
        raise ReplayInputError("invalid_input", "必要な入力項目と一致しません")
    return cast(dict[str, object], value)


def _integer(value: object) -> int | None:
    # JSONでは1.0と1は同じ数です。boolはPythonのint派生ですが受理しません。
    if type(value) is int and abs(value) <= 2**53 - 1:
        return value
    if type(value) is float and value.is_integer() and abs(value) <= 2**53 - 1:
        return int(value)
    return None


def _side(value: object) -> Side:
    if value not in SIDES:
        raise ReplayInputError("invalid_input", "未対応の担当方向です")
    return value


def _position(value: object) -> Position:
    raw = _record(value, {"x", "y"})
    x, y = _integer(raw["x"]), _integer(raw["y"])
    if x is None or y is None or not (0 <= x <= 8 and 0 <= y <= 8):
        raise ReplayInputError("invalid_input", "座標は0〜8の整数です")
    return Position(x, y)


def _event(value: object) -> Event:
    event_type = value.get("type") if isinstance(value, dict) else None
    if event_type == "action":
        raw = _record(value, {"type", "side", "action"})
        action = raw["action"]
        action_type = action.get("type") if isinstance(action, dict) else None
        if action_type == "movePiece":
            fields = _record(action, {"type", "from", "to", "promote"})
            promote = fields["promote"]
            if type(promote) is not bool:
                raise ReplayInputError("invalid_input", "成り指定はbooleanです")
            return ActionEvent(
                _side(raw["side"]),
                MoveAction(_position(fields["from"]), _position(fields["to"]), promote),
            )
        if action_type == "dropPiece":
            fields = _record(action, {"type", "pieceKind", "to"})
            kind = fields["pieceKind"]
            if kind not in ("rook", "gold", "silver", "pawn"):
                raise ReplayInputError("invalid_input", "未対応の持ち駒です")
            return ActionEvent(_side(raw["side"]), DropAction(kind, _position(fields["to"])))
    elif event_type == "eliminate":
        raw = _record(value, {"type", "side", "reason"})
        reason = raw["reason"]
        if reason not in ("resigned", "left", "timeout", "disconnected"):
            raise ReplayInputError("invalid_input", "外部脱落理由が不正です")
        return EliminateEvent(_side(raw["side"]), reason)
    elif event_type == "drawProposal":
        raw = _record(value, {"type", "side", "proposed"})
        proposed = raw["proposed"]
        if type(proposed) is not bool:
            raise ReplayInputError("invalid_input", "引分提案はbooleanです")
        return DrawProposalEvent(_side(raw["side"]), proposed)
    raise ReplayInputError("invalid_input", "未対応のイベントまたは着手です")


def parse_replay(value: object) -> ReplayInput:
    """入力全体の形状を検証し、呼び出し元から独立した不変データを返します。"""
    raw = _record(
        value,
        {"schemaVersion", "ruleProfileId", "rulesVersion", "initial", "events", "eventOffset"},
        {"eventOffset"},
    )
    if _integer(raw["schemaVersion"]) != 1 or _integer(raw["rulesVersion"]) != 1:
        raise ReplayInputError("unsupported_version", "入力・ルールは版1のみ対応しています")
    if raw["ruleProfileId"] != RULE_PROFILE_ID:
        raise ReplayInputError("unsupported_profile", "未対応のルールプロフィールです")
    initial = _record(raw["initial"], {"mode", "players", "threePlayerAttackProhibited"})
    if initial["mode"] != "singles":
        raise ReplayInputError("unsupported_mode", "シングルス専用です")
    prohibited = initial["threePlayerAttackProhibited"]
    if type(prohibited) is not bool:
        raise ReplayInputError("invalid_input", "三人攻撃禁止はbooleanで明示してください")
    players = _record(initial["players"], set(SIDES))
    ids = tuple(players[side] for side in SIDES)
    if not all(isinstance(player, str) and player for player in ids):
        raise ReplayInputError("invalid_input", "四方向の参加者IDが必要です")
    if len(set(ids)) != 4:
        raise ReplayInputError("invalid_input", "参加者IDは重複できません")
    raw_events = raw["events"]
    if not isinstance(raw_events, list):
        raise ReplayInputError("invalid_input", "イベント配列が必要です")
    events: list[Event] = []
    for index, entry in enumerate(raw_events):
        fields = _record(entry, {"index", "event"})
        if _integer(fields["index"]) != index:
            raise ReplayInputError("non_contiguous_events", "indexは0から連続してください", index)
        try:
            events.append(_event(fields["event"]))
        except ReplayInputError as error:
            raise ReplayInputError(error.code, str(error), index) from error
    offset = _integer(raw.get("eventOffset", len(events)))
    if offset is None or not 0 <= offset <= len(events):
        raise ReplayInputError("invalid_offset", "eventOffsetは0〜イベント数の整数です")
    return ReplayInput(
        InitialOptions(cast(tuple[str, str, str, str], ids), prohibited), tuple(events), offset
    )


def _position_dict(position: Position) -> dict[str, int]:
    return {"x": position.x, "y": position.y}


def _event_dict(event: Event) -> dict[str, object]:
    if isinstance(event, EliminateEvent):
        return {"type": "eliminate", "side": event.side, "reason": event.reason}
    if isinstance(event, DrawProposalEvent):
        return {"type": "drawProposal", "side": event.side, "proposed": event.proposed}
    action = event.action
    action_dict: dict[str, object]
    if isinstance(action, MoveAction):
        action_dict = {
            "type": "movePiece",
            "from": _position_dict(action.from_position),
            "to": _position_dict(action.to),
            "promote": action.promote,
        }
    else:
        action_dict = {
            "type": "dropPiece",
            "pieceKind": action.piece_kind,
            "to": _position_dict(action.to),
        }
    return {"type": "action", "side": event.side, "action": action_dict}


def replay_to_dict(replay: ReplayInput) -> dict[str, object]:
    """検証済みの再生入力を、TSと共通のJSON交換形式へ変換します。"""
    return {
        "schemaVersion": 1,
        "ruleProfileId": RULE_PROFILE_ID,
        "rulesVersion": 1,
        "initial": {
            "mode": "singles",
            "players": dict(zip(SIDES, replay.initial.players, strict=True)),
            "threePlayerAttackProhibited": replay.initial.three_player_attack_prohibited,
        },
        "events": [
            {"index": index, "event": _event_dict(event)}
            for index, event in enumerate(replay.events)
        ],
        "eventOffset": replay.event_offset,
    }
