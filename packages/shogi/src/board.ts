import {
  sides,
  type Board,
  type Cell,
  type Hands,
  type Piece,
  type Position,
  type ShogiState,
  type Side,
} from "./types";

export function inBounds(position: Position): boolean {
  return (
    Number.isInteger(position?.x) &&
    Number.isInteger(position?.y) &&
    position.x >= 0 &&
    position.x < 9 &&
    position.y >= 0 &&
    position.y < 9
  );
}
export function pieces(board: Board): { piece: Piece; position: Position }[] {
  const found: { piece: Piece; position: Position }[] = [];
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++) {
      const piece = board[y][x];
      if (piece) found.push({ piece, position: { x, y } });
    }
  return found;
}
export function forwardForSide(side: Side): Position {
  return { x: 0, y: side === "south" ? -1 : 1 };
}
export function inPromotionZone(side: Side, position: Position): boolean {
  return inBounds(position) && (side === "south" ? position.y <= 2 : position.y >= 6);
}
export function deadEnd(kind: Piece["kind"], side: Side, to: Position): boolean {
  const rank = side === "south" ? to.y : 8 - to.y;
  return kind === "pawn" || kind === "lance" ? rank === 0 : kind === "knight" && rank <= 1;
}
export function attacksSquare(board: Board, piece: Piece, from: Position, to: Position): boolean {
  if (!inBounds(from) || !inBounds(to)) return false;
  const dx = to.x - from.x,
    dy = to.y - from.y;
  if (dx === 0 && dy === 0) return false;
  const ahead = dy * (piece.side === "south" ? -1 : 1);
  const adjacent = Math.max(Math.abs(dx), Math.abs(dy)) === 1;
  if (piece.kind === "king") return adjacent;
  if (
    piece.kind === "rook" ||
    piece.kind === "bishop" ||
    (piece.kind === "lance" && !piece.promoted)
  ) {
    if (
      piece.promoted &&
      adjacent &&
      (piece.kind === "rook" ? Math.abs(dx) === Math.abs(dy) : dx === 0 || dy === 0)
    )
      return true;
    const ray =
      piece.kind === "rook"
        ? dx === 0 || dy === 0
        : piece.kind === "bishop"
          ? Math.abs(dx) === Math.abs(dy)
          : dx === 0 && ahead > 0;
    if (!ray) return false;
    const stepX = Math.sign(dx),
      stepY = Math.sign(dy);
    for (
      let x = from.x + stepX, y = from.y + stepY;
      x !== to.x || y !== to.y;
      x += stepX, y += stepY
    )
      if (board[y][x]) return false;
    return true;
  }
  if (piece.kind === "knight" && !piece.promoted) return ahead === 2 && Math.abs(dx) === 1;
  if (!adjacent) return false;
  if (piece.kind === "gold" || piece.promoted)
    return ahead === 1 || (ahead === 0 && Math.abs(dx) === 1) || (ahead === -1 && dx === 0);
  if (piece.kind === "silver")
    return (ahead === 1 && dx === 0) || (Math.abs(ahead) === 1 && Math.abs(dx) === 1);
  return ahead === 1 && dx === 0;
}
export function attackedPositions(board: Board, piece: Piece, from: Position): Position[] {
  const found: Position[] = [];
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++)
      if (attacksSquare(board, piece, from, { x, y })) found.push({ x, y });
  return found;
}
export function isInCheck(state: Pick<ShogiState, "board">, side: Side): boolean {
  const all = pieces(state.board);
  const king = all.find((p) => p.piece.side === side && p.piece.kind === "king");
  return (
    !!king &&
    all.some(
      (p) =>
        p.piece.side !== side && attacksSquare(state.board, p.piece, p.position, king.position),
    )
  );
}
export function getCheckState(state: Pick<ShogiState, "board">): Record<Side, boolean> {
  return { south: isInCheck(state, "south"), north: isInCheck(state, "north") };
}
export function createInitialBoard(): { board: Cell[][]; nextPieceId: number } {
  const board: Cell[][] = Array.from({ length: 9 }, () => Array<Cell>(9).fill(null));
  let nextPieceId = 1;
  const back = [
    "lance",
    "knight",
    "silver",
    "gold",
    "king",
    "gold",
    "silver",
    "knight",
    "lance",
  ] as const;
  const place = (side: Side, x: number, y: number, kind: Piece["kind"]) => {
    if (side === "north") {
      x = 8 - x;
      y = 8 - y;
    }
    board[y][x] = { id: nextPieceId++, side, kind, promoted: false };
  };
  for (const side of sides) {
    back.forEach((kind, x) => place(side, x, 8, kind));
    place(side, 1, 7, "bishop");
    place(side, 7, 7, "rook");
    for (let x = 0; x < 9; x++) place(side, x, 6, "pawn");
  }
  return { board, nextPieceId };
}
export function emptyHands(): Hands {
  const empty = () => ({ rook: 0, bishop: 0, gold: 0, silver: 0, knight: 0, lance: 0, pawn: 0 });
  return { south: empty(), north: empty() };
}
