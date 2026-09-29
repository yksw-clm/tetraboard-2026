export const colors = ["black", "white", "red", "blue"] as const;

export type Color = (typeof colors)[number];
export type Cell = Color | null;
export type Position = { x: number; y: number };
export type FourReversiState = {
  board: readonly (readonly Cell[])[];
  turn: Color;
  moveNumber: number;
};
export type FourReversiAction = { type: "placeStone"; position: Position };
export type MoveError = "out_of_bounds" | "occupied" | "no_capture" | "eliminates_player";
export type ApplyActionResult =
  | { ok: true; state: FourReversiState; flipped: readonly Position[] }
  | { ok: false; reason: MoveError };

const initialRows = [
  "........",
  "........",
  "...K....",
  "...RKB..",
  "..RWB...",
  "....W...",
  "........",
  "........",
] as const;
const symbolToCell: Record<string, Cell> = {
  ".": null,
  K: "black",
  W: "white",
  R: "red",
  B: "blue",
};
const directions = [-1, 0, 1].flatMap((dy) =>
  [-1, 0, 1].filter((dx) => dx !== 0 || dy !== 0).map((dx) => ({ dx, dy })),
);

export function createInitialState(): FourReversiState {
  return {
    board: initialRows.map((row) => [...row].map((symbol) => symbolToCell[symbol])),
    turn: "black",
    moveNumber: 0,
  };
}

function inBounds(position: Position): boolean {
  return (
    Number.isInteger(position.x) &&
    Number.isInteger(position.y) &&
    position.x >= 0 &&
    position.x < 8 &&
    position.y >= 0 &&
    position.y < 8
  );
}

function capturedStones(state: FourReversiState, position: Position): Position[] {
  const captured: Position[] = [];
  for (const { dx, dy } of directions) {
    const line: Position[] = [];
    let x = position.x + dx;
    let y = position.y + dy;
    while (x >= 0 && x < 8 && y >= 0 && y < 8) {
      const cell = state.board[y][x];
      if (cell === null) break;
      if (cell === state.turn) {
        if (line.length > 0) captured.push(...line);
        break;
      }
      line.push({ x, y });
      x += dx;
      y += dy;
    }
  }
  return captured;
}

export function applyAction(state: FourReversiState, action: FourReversiAction): ApplyActionResult {
  const { position } = action;
  if (!inBounds(position)) return { ok: false, reason: "out_of_bounds" };
  if (state.board[position.y][position.x] !== null) return { ok: false, reason: "occupied" };

  const flipped = capturedStones(state, position);
  if (flipped.length === 0) return { ok: false, reason: "no_capture" };

  const board = state.board.map((row) => [...row]);
  board[position.y][position.x] = state.turn;
  for (const stone of flipped) board[stone.y][stone.x] = state.turn;
  if (colors.some((color) => color !== state.turn && !board.some((row) => row.includes(color)))) {
    return { ok: false, reason: "eliminates_player" };
  }

  return {
    ok: true,
    state: {
      board,
      turn: colors[(colors.indexOf(state.turn) + 1) % colors.length],
      moveNumber: state.moveNumber + 1,
    },
    flipped,
  };
}

export function getLegalMoves(state: FourReversiState): Position[] {
  const moves: Position[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const position = { x, y };
      if (applyAction(state, { type: "placeStone", position }).ok) moves.push(position);
    }
  }
  return moves;
}
