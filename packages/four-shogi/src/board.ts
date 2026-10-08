import {
  areEnemies,
  getActiveSides,
  sides,
  type Board,
  type Cell,
  type FourShogiState,
  type Hands,
  type Piece,
  type PieceKind,
  type Position,
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
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const piece = board[y][x];
      if (piece !== null) found.push({ piece, position: { x, y } });
    }
  }
  return found;
}

export function forwardForSide(side: Side): Position {
  switch (side) {
    case "south":
      return { x: 0, y: -1 };
    case "west":
      return { x: 1, y: 0 };
    case "north":
      return { x: 0, y: 1 };
    case "east":
      return { x: -1, y: 0 };
  }
}

export function inPromotionZone(side: Side, position: Position): boolean {
  if (!inBounds(position)) return false;
  switch (side) {
    case "south":
      return position.y <= 2;
    case "west":
      return position.x >= 6;
    case "north":
      return position.y >= 6;
    case "east":
      return position.x <= 2;
  }
}

export function isFinalRank(side: Side, position: Position): boolean {
  switch (side) {
    case "south":
      return position.y === 0;
    case "west":
      return position.x === 8;
    case "north":
      return position.y === 8;
    case "east":
      return position.x === 0;
  }
}

export function attacksSquare(board: Board, piece: Piece, from: Position, to: Position): boolean {
  if (!inBounds(from) || !inBounds(to)) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return false;

  if (piece.kind === "rook") {
    if (piece.promoted && Math.abs(dx) === 1 && Math.abs(dy) === 1) return true;
    if (dx !== 0 && dy !== 0) return false;
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    for (
      let x = from.x + stepX, y = from.y + stepY;
      x !== to.x || y !== to.y;
      x += stepX, y += stepY
    ) {
      if (board[y][x] !== null) return false;
    }
    return true;
  }

  if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) return false;
  if (piece.kind === "king") return true;
  const forward = forwardForSide(piece.side);
  const right = { x: -forward.y, y: forward.x };
  const ahead = dx * forward.x + dy * forward.y;
  const sideways = dx * right.x + dy * right.y;
  if (piece.kind === "gold" || piece.promoted) {
    return (
      ahead === 1 || (ahead === 0 && Math.abs(sideways) === 1) || (ahead === -1 && sideways === 0)
    );
  }
  if (piece.kind === "silver") {
    return (ahead === 1 && sideways === 0) || (Math.abs(ahead) === 1 && Math.abs(sideways) === 1);
  }
  return ahead === 1 && sideways === 0;
}

export function isInCheck(state: FourShogiState, side: Side): boolean {
  const active = getActiveSides(state);
  if (!active.includes(side)) return false;
  const all = pieces(state.board);
  const king = all.find(({ piece }) => piece.side === side && piece.kind === "king");
  if (!king) return false;
  return all.some(
    ({ piece, position }) =>
      active.includes(piece.side) &&
      areEnemies(state.mode, side, piece.side) &&
      attacksSquare(state.board, piece, position, king.position),
  );
}

export function attackedPositions(board: Board, piece: Piece, from: Position): Position[] {
  const found: Position[] = [];
  if (piece.kind === "rook") {
    for (const [dx, dy] of [
      [0, -1],
      [-1, 0],
      [1, 0],
      [0, 1],
    ]) {
      for (
        let x = from.x + dx, y = from.y + dy;
        x >= 0 && x < 9 && y >= 0 && y < 9;
        x += dx, y += dy
      ) {
        found.push({ x, y });
        if (board[y][x] !== null) break;
      }
    }
    if (piece.promoted) {
      for (const dx of [-1, 1])
        for (const dy of [-1, 1]) {
          const to = { x: from.x + dx, y: from.y + dy };
          if (inBounds(to)) found.push(to);
        }
    }
  } else {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const to = { x: from.x + dx, y: from.y + dy };
        if (attacksSquare(board, piece, from, to)) found.push(to);
      }
  }
  return found;
}

export function getCheckState(state: FourShogiState): Record<Side, boolean> {
  return {
    south: isInCheck(state, "south"),
    west: isInCheck(state, "west"),
    north: isInCheck(state, "north"),
    east: isInCheck(state, "east"),
  };
}

export function positionForSide({ x, y }: Position, side: Side): Position {
  switch (side) {
    case "south":
      return { x, y };
    case "west":
      return { x: 8 - y, y: x };
    case "north":
      return { x: 8 - x, y: 8 - y };
    case "east":
      return { x: y, y: 8 - x };
  }
}

export function createInitialBoard(): { board: Cell[][]; nextPieceId: number } {
  const board: Cell[][] = Array.from({ length: 9 }, () => Array<Cell>(9).fill(null));
  const south: { kind: PieceKind; x: number; y: number }[] = [
    { kind: "king", x: 4, y: 8 },
    { kind: "rook", x: 4, y: 7 },
    { kind: "gold", x: 3, y: 8 },
    { kind: "gold", x: 5, y: 8 },
    { kind: "silver", x: 2, y: 8 },
    { kind: "silver", x: 6, y: 8 },
    { kind: "pawn", x: 3, y: 7 },
    { kind: "pawn", x: 5, y: 7 },
    { kind: "pawn", x: 4, y: 6 },
  ];
  let nextPieceId = 1;
  for (const side of sides) {
    for (const { kind, x, y } of south) {
      const position = positionForSide({ x, y }, side);
      board[position.y][position.x] = { id: nextPieceId++, side, kind, promoted: false };
    }
  }
  return { board, nextPieceId };
}

export function emptyHands(): Hands {
  return {
    south: { rook: 0, gold: 0, silver: 0, pawn: 0 },
    west: { rook: 0, gold: 0, silver: 0, pawn: 0 },
    north: { rook: 0, gold: 0, silver: 0, pawn: 0 },
    east: { rook: 0, gold: 0, silver: 0, pawn: 0 },
  };
}
