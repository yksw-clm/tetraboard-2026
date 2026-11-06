"""三人攻撃の分類・制限・受理後の履歴更新を扱います。"""

from dataclasses import replace

from .board import active_sides, attacks_square, in_bounds, is_in_check, pieces
from .moves import OrdinaryMove, has_ordinary_move
from .replay import SIDES, Position, Side
from .state import AttackReason, AttackRelation, Board, Piece, State

type LocatedPiece = tuple[Piece, Position]


def uses_restriction(state: State) -> bool:
    return state.initial.three_player_attack_prohibited and len(active_sides(state)) == 4


def threatens_target(
    board: Board,
    attacker: LocatedPiece,
    target: LocatedPiece,
    king: LocatedPiece,
    defenders: tuple[LocatedPiece, ...],
) -> bool:
    piece, origin = attacker
    victim, at = target
    if (
        piece.kind == "king"
        or victim.kind == "king"
        or not attacks_square(board, piece, origin, at)
    ):
        return False
    if victim.kind == "rook":
        return True
    defended = any(p.id != victim.id and attacks_square(board, p, pos, at) for p, pos in defenders)
    if victim.kind == "pawn":
        king_pos = king[1]
        return max(abs(at.x - king_pos.x), abs(at.y - king_pos.y)) <= 2 and (
            piece.kind == "pawn" or not defended
        )
    return piece.kind != "rook" or not defended


def covers_king_neighbor(board: Board, attacker: LocatedPiece, king: LocatedPiece) -> bool:
    piece, origin = attacker
    king_piece, at = king
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            to = Position(at.x + dx, at.y + dy)
            if (dx == dy == 0) or not in_bounds(to):
                continue
            occupant = board[to.y][to.x]
            if occupant and occupant.side == king_piece.side:
                continue
            if attacks_square(board, piece, origin, to):
                return True
    return False


def classify_attacks(before: State, side: Side, move: OrdinaryMove) -> tuple[AttackRelation, ...]:
    if not uses_restriction(before) or is_in_check(before, side):
        return ()
    if move.captured and move.action.to in before.recapture_squares[SIDES.index(side)]:
        return ()
    previous = {p.id: (p, pos) for p, pos in pieces(before.board)}
    located = tuple(pieces(move.state.board))
    own = tuple(entry for entry in located if entry[0].side == side)
    relations = []
    for target_side in SIDES:
        if target_side == side:
            continue
        targets = tuple(entry for entry in located if entry[0].side == target_side)
        king = next((entry for entry in targets if entry[0].kind == "king"), None)
        if king is None:
            continue
        old_king = previous.get(king[0].id)
        reasons: list[AttackReason] = []
        target_ids = []
        if not is_in_check(before, target_side) and is_in_check(move.state, target_side):
            reasons.append("check")
        if (
            move.piece.kind != "king"
            and move.captured
            and move.captured.side == target_side
            and move.captured.kind not in ("pawn", "king")
        ):
            reasons.append("capture")
        for target in targets:
            if target[0].kind == "king":
                continue
            if any(
                r.target == target_side
                and "threat" in r.reasons
                and target[0].id in r.target_piece_ids
                for r in before.attack_relations
            ):
                continue
            for attacker in own:
                if not threatens_target(move.state.board, attacker, target, king, targets):
                    continue
                old_attacker, old_target = previous.get(attacker[0].id), previous.get(target[0].id)
                if (
                    old_attacker is None
                    or old_target is None
                    or not attacks_square(
                        before.board, old_attacker[0], old_attacker[1], old_target[1]
                    )
                ):
                    target_ids.append(target[0].id)
                    break
        if target_ids:
            reasons.append("threat")
        for attacker in located:
            if attacker[0].side == target_side or attacker[0].kind == "king":
                continue
            if not covers_king_neighbor(move.state.board, attacker, king):
                continue
            old_attacker = previous.get(attacker[0].id)
            # 同じ駒が王の周囲のどこかへ利いていれば、全マスが入れ替わっても維持です。
            if (
                old_attacker is None
                or old_king is None
                or not covers_king_neighbor(before.board, old_attacker, old_king)
            ):
                reasons.append("blockade")
                break
        if reasons:
            relations.append(
                AttackRelation(
                    side,
                    target_side,
                    tuple(reasons),
                    tuple(sorted(target_ids)),
                    tuple(s for s in SIDES if s != side),
                )
            )
    return tuple(relations)


def restricted_targets(state: State, side: Side) -> tuple[Side, ...]:
    if not uses_restriction(state) or is_in_check(state, side):
        return ()
    return tuple(
        target
        for target in SIDES
        if target != side
        and len(
            {
                r.attacker
                for r in state.attack_relations
                if r.target == target and r.attacker != side
            }
        )
        >= 2
    )


def filter_moves(
    state: State, side: Side, moves: tuple[OrdinaryMove, ...]
) -> tuple[OrdinaryMove, ...]:
    restricted = restricted_targets(state, side)
    if not restricted:
        return moves
    classified = tuple(
        (move, {r.target for r in classify_attacks(state, side, move)}) for move in moves
    )
    avoidable = tuple(
        target for target in restricted if any(target not in targets for _, targets in classified)
    )
    # 一手撃破の応手判定は通常合法手だけを使い、三人攻撃の探索へ再入しません。
    return tuple(
        move
        for move, targets in classified
        if all(
            target not in targets
            or (is_in_check(move.state, target) and not has_ordinary_move(move.state, target))
            for target in avoidable
        )
    )


def update_history(before: State, side: Side, move: OrdinaryMove) -> State:
    if not uses_restriction(before) or not uses_restriction(move.state):
        return replace(move.state, attack_relations=(), recapture_squares=((), (), (), ()))
    new_relations = classify_attacks(before, side, move)
    replaced = {(r.attacker, r.target) for r in new_relations}
    relations = []
    for relation in before.attack_relations:
        pending = tuple(s for s in relation.pending_sides if s != side)
        if pending and (relation.attacker, relation.target) not in replaced:
            relations.append(replace(relation, pending_sides=pending))
    recaptures = list(before.recapture_squares)
    recaptures[SIDES.index(side)] = ()
    if move.captured:
        index = SIDES.index(move.captured.side)
        if move.action.to not in recaptures[index]:
            recaptures[index] += (move.action.to,)
    return replace(
        move.state,
        attack_relations=tuple(relations) + new_relations,
        recapture_squares=tuple(recaptures),
    )
