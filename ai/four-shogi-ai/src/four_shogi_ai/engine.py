"""シングルスのON／OFFに対応する確定遷移と完全状態再生を提供します。"""

import json
from dataclasses import replace

from .attacks import filter_moves, restricted_targets, update_history, uses_restriction
from .board import active_sides, initial_board, is_in_check, pieces
from .moves import has_ordinary_move, ordinary_moves, validate
from .replay import (
    SIDES,
    Action,
    ActionEvent,
    DrawProposalEvent,
    Event,
    InitialOptions,
    ReplayInput,
    Side,
)
from .state import (
    HAND_KINDS,
    Elimination,
    EliminationReason,
    FinishReason,
    GameResult,
    Hand,
    MoveError,
    MoveRecord,
    Standing,
    State,
    TransitionFailure,
    TransitionResult,
    TransitionSuccess,
)


def position_key(state: State) -> str:
    active = active_sides(state)
    board = [
        [None if p is None else [p.side, p.kind, p.promoted] for p in row] for row in state.board
    ]
    hands = [
        [side, [state.hands[SIDES.index(side)].count(kind) for kind in HAND_KINDS]]
        for side in active
    ]
    positions = {p.id: pos.y * 9 + pos.x for p, pos in pieces(state.board)}
    attacks = (
        [
            [
                r.attacker,
                r.target,
                sorted(set(r.reasons)),
                sorted({positions[i] for i in r.target_piece_ids if i in positions}),
                [side for side in SIDES if side in r.pending_sides],
            ]
            for r in sorted(
                state.attack_relations,
                key=lambda r: (SIDES.index(r.attacker), SIDES.index(r.target)),
            )
        ]
        if uses_restriction(state)
        else []
    )
    recaptures = (
        [sorted({p.y * 9 + p.x for p in squares}) for squares in state.recapture_squares]
        if uses_restriction(state)
        else []
    )
    return json.dumps(
        [board, hands, active, state.turn, attacks, recaptures], separators=(",", ":")
    )


def record_position(state: State) -> State:
    key = position_key(state)
    counts = dict(state.repetitions)
    counts[key] = counts.get(key, 0) + 1
    return replace(state, repetitions=tuple(counts.items()))


def create_initial_state(options: InitialOptions) -> State:
    return record_position(State(options, initial_board(), 37))


def legal_actions(state: State) -> tuple[Action, ...]:
    if state.status == "finished" or state.turn is None:
        return ()
    return tuple(
        move.action
        for move in filter_moves(state, state.turn, tuple(ordinary_moves(state, state.turn)))
    )


def eliminate_batch(state: State, sides: tuple[Side, ...], reason: EliminationReason) -> State:
    rank = len(active_sides(state)) - len(sides) + 1
    group = max((e.group for e in state.eliminations), default=0) + 1
    return replace(
        state,
        hands=tuple(Hand() if side in sides else state.hands[i] for i, side in enumerate(SIDES)),
        eliminations=state.eliminations
        + tuple(Elimination(side, reason, group, rank) for side in sides),
        draw_proposals=tuple(side for side in state.draw_proposals if side not in sides),
        attack_relations=(),
        recapture_squares=((), (), (), ()),
    )


def finish(state: State, reason: FinishReason) -> State:
    ranks = {e.side: e.rank for e in state.eliminations}
    standings = tuple(
        sorted((Standing(side, ranks.get(side, 1)) for side in SIDES), key=lambda s: s.rank)
    )
    return replace(state, status="finished", turn=None, result=GameResult(reason, standings))


def finish_if_eliminated(state: State) -> State:
    count = len(active_sides(state))
    return finish(state, "last_player" if count == 1 else "no_survivors") if count <= 1 else state


def finish_if_agreed(state: State) -> State:
    if state.status == "playing" and all(
        side in state.draw_proposals for side in active_sides(state)
    ):
        return finish(state, "agreement")
    return state


def next_side(state: State, after: Side) -> Side:
    active = active_sides(state)
    checked = tuple(side for side in active if is_in_check(state, side))
    candidates = checked or active
    return next(
        SIDES[(SIDES.index(after) + offset) % 4]
        for offset in range(1, 5)
        if SIDES[(SIDES.index(after) + offset) % 4] in candidates
    )


def settle(state: State, after: Side, preserve_turn: bool = False) -> State:
    state = finish_if_eliminated(state)
    if state.status == "finished":
        return state
    # 同じ盤面で全王の詰み集合を固定してから、一括で利きを消します。
    mated = tuple(
        side
        for side in active_sides(state)
        if is_in_check(state, side) and not has_ordinary_move(state, side)
    )
    if mated:
        state = finish_if_eliminated(eliminate_batch(state, mated, "checkmate"))
    if state.status == "finished":
        return state
    selected = (
        state.turn
        if preserve_turn and state.turn in active_sides(state)
        else next_side(state, after)
    )
    assert selected is not None
    while True:
        state = replace(state, turn=selected)
        if (
            bool(legal_actions(state))
            if restricted_targets(state, selected)
            else has_ordinary_move(state, selected)
        ):
            break
        state = finish_if_eliminated(eliminate_batch(state, (selected,), "no_legal_actions"))
        if state.status == "finished":
            return state
        selected = next_side(state, selected)
    state = finish_if_agreed(state)
    if state.status == "finished":
        return state
    state = record_position(state)
    return (
        finish(state, "repetition") if dict(state.repetitions)[position_key(state)] >= 4 else state
    )


def apply_event(state: State, event: Event) -> TransitionResult:
    if state.status == "finished":
        return TransitionFailure("game_finished")
    if event.side not in active_sides(state):
        return TransitionFailure("already_eliminated")
    if isinstance(event, (ActionEvent, DrawProposalEvent)) or event.reason == "resigned":
        if state.turn != event.side:
            return TransitionFailure("not_your_turn")
    if isinstance(event, DrawProposalEvent):
        proposals = tuple(
            side
            for side in SIDES
            if (event.proposed if side == event.side else side in state.draw_proposals)
        )
        return TransitionSuccess(finish_if_agreed(replace(state, draw_proposals=proposals)))
    if isinstance(event, ActionEvent):
        move = validate(state, event.side, event.action)
        if isinstance(move, TransitionFailure):
            return move
        if restricted_targets(state, event.side) and event.action not in legal_actions(state):
            return TransitionFailure("three_player_attack")
        moved = replace(
            update_history(state, event.side, move),
            move_number=state.move_number + 1,
            last_move=MoveRecord(event.side, event.action, move.piece, move.captured),
        )
        result = settle(moved, event.side)
        captured = move.captured
    else:
        result = settle(
            eliminate_batch(state, (event.side,), event.reason),
            event.side,
            state.turn != event.side,
        )
        captured = None
    return TransitionSuccess(result, captured, result.eliminations[len(state.eliminations) :])


class ReplayExecutionError(ValueError):
    code = "event_rejected"

    def __init__(self, event_index: int, reason: MoveError) -> None:
        super().__init__(f"イベント{event_index}を受理できません: {reason}")
        self.event_index = event_index
        self.reason = reason


def replay(input: ReplayInput) -> State:
    state = create_initial_state(input.initial)
    for index, event in enumerate(input.events[: input.event_offset]):
        result = apply_event(state, event)
        if not result.ok:
            raise ReplayExecutionError(index, result.reason)
        state = result.state
    return state
