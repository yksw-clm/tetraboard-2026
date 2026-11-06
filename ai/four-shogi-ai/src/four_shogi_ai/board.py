"""四方向の幾何学的な利き。ピンされた駒も利きを持ちます。"""

from collections.abc import Iterator

from .replay import SIDES, Position, Side
from .state import Board, Piece, PieceKind, State


def active_sides(state: State) -> tuple[Side, ...]:
    return tuple(side for side in SIDES if all(e.side != side for e in state.eliminations))


def pieces(board: Board) -> Iterator[tuple[Piece, Position]]:
    for y, row in enumerate(board):
        for x, piece in enumerate(row):
            if piece is not None:
                yield piece, Position(x, y)


def in_bounds(pos: Position) -> bool:
    return type(pos.x) is int and type(pos.y) is int and 0 <= pos.x < 9 and 0 <= pos.y < 9


def forward(side: Side) -> tuple[int, int]:
    return ((0, -1), (1, 0), (0, 1), (-1, 0))[SIDES.index(side)]


def depth(side: Side, pos: Position) -> int:
    return (pos.y, 8 - pos.x, 8 - pos.y, pos.x)[SIDES.index(side)]


def attacks_square(board: Board, piece: Piece, origin: Position, to: Position) -> bool:
    if not in_bounds(origin) or not in_bounds(to) or origin == to:
        return False
    dx, dy = to.x - origin.x, to.y - origin.y
    if piece.kind == "rook":
        if piece.promoted and abs(dx) == abs(dy) == 1:
            return True
        if dx and dy:
            return False
        sx, sy = (dx > 0) - (dx < 0), (dy > 0) - (dy < 0)
        x, y = origin.x + sx, origin.y + sy
        while (x, y) != (to.x, to.y):
            if board[y][x] is not None:
                return False
            x, y = x + sx, y + sy
        return True
    if max(abs(dx), abs(dy)) != 1:
        return False
    if piece.kind == "king":
        return True
    fx, fy = forward(piece.side)
    ahead, sideways = dx * fx + dy * fy, -dx * fy + dy * fx
    if piece.kind == "gold" or piece.promoted:
        return ahead == 1 or (ahead == 0 and abs(sideways) == 1) or (ahead == -1 and sideways == 0)
    if piece.kind == "silver":
        return (ahead == 1 and sideways == 0) or (abs(ahead) == abs(sideways) == 1)
    return ahead == 1 and sideways == 0


def destinations(board: Board, piece: Piece, origin: Position) -> Iterator[Position]:
    if piece.kind == "rook":
        for dx, dy in ((0, -1), (-1, 0), (1, 0), (0, 1)):
            to = Position(origin.x + dx, origin.y + dy)
            while in_bounds(to):
                yield to
                if board[to.y][to.x] is not None:
                    break
                to = Position(to.x + dx, to.y + dy)
        if piece.promoted:
            for dx in (-1, 1):
                for dy in (-1, 1):
                    to = Position(origin.x + dx, origin.y + dy)
                    if in_bounds(to):
                        yield to
    else:
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                to = Position(origin.x + dx, origin.y + dy)
                if attacks_square(board, piece, origin, to):
                    yield to


def is_in_check(state: State, side: Side) -> bool:
    active = active_sides(state)
    if side not in active:
        return False
    located = tuple(pieces(state.board))
    king = next((pos for p, pos in located if p.side == side and p.kind == "king"), None)
    return king is not None and any(
        p.side != side and p.side in active and attacks_square(state.board, p, pos, king)
        for p, pos in located
    )


def initial_board() -> Board:
    board: list[list[Piece | None]] = [[None] * 9 for _ in range(9)]
    layout: tuple[tuple[PieceKind, int, int], ...] = (
        ("king", 4, 8),
        ("rook", 4, 7),
        ("gold", 3, 8),
        ("gold", 5, 8),
        ("silver", 2, 8),
        ("silver", 6, 8),
        ("pawn", 3, 7),
        ("pawn", 5, 7),
        ("pawn", 4, 6),
    )
    identity = 1
    for side in SIDES:
        for kind, x, y in layout:
            for _ in range(SIDES.index(side)):
                x, y = 8 - y, x
            board[y][x] = Piece(identity, side, kind)
            identity += 1
    return tuple(tuple(row) for row in board)
