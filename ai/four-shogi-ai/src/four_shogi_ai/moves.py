"""三人攻撃制限より前の通常合法手。適用と列挙で同じ裁定を使います。"""

from collections.abc import Iterator
from dataclasses import dataclass, replace
from typing import cast

from .board import (
    active_sides,
    attacks_square,
    depth,
    destinations,
    forward,
    in_bounds,
    is_in_check,
    pieces,
)
from .replay import SIDES, Action, DropAction, HandPieceKind, MoveAction, Position, Side
from .state import HAND_KINDS, Piece, State, TransitionFailure


@dataclass(frozen=True, slots=True)
class OrdinaryMove:
    action: Action
    state: State
    piece: Piece
    captured: Piece | None


def promotion_possible(piece: Piece, origin: Position, to: Position) -> bool:
    return (
        not piece.promoted
        and piece.kind in ("rook", "silver", "pawn")
        and min(depth(piece.side, origin), depth(piece.side, to)) <= 2
    )


def validate(
    state: State, side: Side, action: Action, check_pawn_mate: bool = True
) -> OrdinaryMove | TransitionFailure:
    if state.status == "finished":
        return TransitionFailure("game_finished")
    active = active_sides(state)
    if side not in active:
        return TransitionFailure("already_eliminated")
    if not in_bounds(action.to):
        return TransitionFailure("out_of_bounds")
    captured = state.board[action.to.y][action.to.x]
    next_id = state.next_piece_id
    hand = state.hands[SIDES.index(side)]
    if isinstance(action, MoveAction):
        origin = action.from_position
        if not in_bounds(origin):
            return TransitionFailure("out_of_bounds")
        original = state.board[origin.y][origin.x]
        if original is None:
            return TransitionFailure("no_piece")
        if original.side != side:
            return TransitionFailure("not_your_piece")
        if captured and captured.side == side:
            return TransitionFailure("friendly_piece")
        if captured and captured.kind == "king":
            return TransitionFailure("king_capture")
        if not attacks_square(state.board, original, origin, action.to):
            return TransitionFailure("invalid_movement")
        if action.promote and not promotion_possible(original, origin, action.to):
            return TransitionFailure("invalid_promotion")
        if (
            original.kind == "pawn"
            and not original.promoted
            and depth(side, action.to) == 0
            and not action.promote
        ):
            return TransitionFailure("promotion_required")
        piece = replace(original, promoted=original.promoted or action.promote)
        if captured:
            kind = cast(HandPieceKind, captured.kind)
            hand = replace(hand, **{kind: hand.count(kind) + 1})
    else:
        if captured:
            return TransitionFailure("occupied")
        if hand.count(action.piece_kind) <= 0:
            return TransitionFailure("missing_hand_piece")
        if action.piece_kind == "pawn":
            if depth(side, action.to) == 0:
                return TransitionFailure("dead_end_pawn")
            vertical = side in ("south", "north")
            if any(
                p.side == side
                and p.kind == "pawn"
                and not p.promoted
                and (pos.x == action.to.x if vertical else pos.y == action.to.y)
                for p, pos in pieces(state.board)
            ):
                return TransitionFailure("nifu")
            fx, fy = forward(side)
            ahead = Position(action.to.x + fx, action.to.y + fy)
            king = state.board[ahead.y][ahead.x] if in_bounds(ahead) else None
            if king and king.kind == "king" and king.side not in active:
                return TransitionFailure("dead_king_pawn_drop")
        piece = Piece(next_id, side, action.piece_kind)
        next_id += 1
        hand = replace(hand, **{action.piece_kind: hand.count(action.piece_kind) - 1})
    board = [list(row) for row in state.board]
    if isinstance(action, MoveAction):
        board[action.from_position.y][action.from_position.x] = None
    board[action.to.y][action.to.x] = piece
    candidate = replace(
        state,
        board=tuple(tuple(row) for row in board),
        next_piece_id=next_id,
        hands=tuple(hand if s == side else state.hands[i] for i, s in enumerate(SIDES)),
    )
    if is_in_check(candidate, side):
        return TransitionFailure("self_check")
    if check_pawn_mate and isinstance(action, DropAction) and action.piece_kind == "pawn":
        fx, fy = forward(side)
        ahead = Position(action.to.x + fx, action.to.y + fy)
        king = board[ahead.y][ahead.x] if in_bounds(ahead) else None
        if (
            king
            and king.kind == "king"
            and king.side != side
            and king.side in active
            and not pawn_check_response(candidate, king.side, action.to)
        ):
            return TransitionFailure("pawn_drop_mate")
    return OrdinaryMove(action, candidate, piece, captured)


def move_actions(piece: Piece, origin: Position, to: Position) -> Iterator[MoveAction]:
    yield MoveAction(origin, to, False)
    if promotion_possible(piece, origin, to):
        yield MoveAction(origin, to, True)


def pawn_check_response(state: State, side: Side, pawn: Position) -> bool:
    # 隣接する歩の王手は合駒で遮れません。王の移動か歩の捕獲に限定し再帰を避けます。
    for piece, origin in pieces(state.board):
        if piece.side != side:
            continue
        targets = (
            destinations(state.board, piece, origin) if piece.kind == "king" else iter((pawn,))
        )
        for to in targets:
            for action in move_actions(piece, origin, to):
                if isinstance(validate(state, side, action, False), OrdinaryMove):
                    return True
    return False


def ordinary_moves(state: State, side: Side) -> Iterator[OrdinaryMove]:
    if state.status == "finished" or side not in active_sides(state):
        return
    for piece, origin in pieces(state.board):
        if piece.side != side:
            continue
        for to in sorted(destinations(state.board, piece, origin), key=lambda p: (p.y, p.x)):
            for action in move_actions(piece, origin, to):
                result = validate(state, side, action)
                if isinstance(result, OrdinaryMove):
                    yield result
    for kind in HAND_KINDS:
        if state.hands[SIDES.index(side)].count(kind) <= 0:
            continue
        for y in range(9):
            for x in range(9):
                result = validate(state, side, DropAction(kind, Position(x, y)))
                if isinstance(result, OrdinaryMove):
                    yield result


def has_ordinary_move(state: State, side: Side) -> bool:
    return next(ordinary_moves(state, side), None) is not None
