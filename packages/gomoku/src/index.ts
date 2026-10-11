export const boardSize = 15;
export const rulesVersion = 1;
export const colors = ["black", "white"] as const;
export type Color = (typeof colors)[number];
export type Cell = Color | null;
export type Position = { x: number; y: number };
export type Board = readonly (readonly Cell[])[];
export type GameResult = {
  reason: "five" | "board_full" | "no_legal_moves" | "last_player";
  winner: Color | null;
  stoneCounts: Record<Color, number>;
  winningLines: Position[][];
};
type StateBase = {
  rulesVersion: typeof rulesVersion;
  forbiddenRules: boolean;
  board: Board;
  moveNumber: number;
  lastMove: Position | null;
  eliminatedColors: readonly Color[];
};
export type GomokuState =
  | (StateBase & { status: "playing"; turn: Color; result: null })
  | (StateBase & { status: "finished"; turn: null; result: GameResult });
export type GomokuAction = { type: "placeStone"; position: Position };
export type ApplyActionResult =
  | { ok: true; state: GomokuState }
  | { ok: false; reason: "game_finished" | "out_of_bounds" | "occupied" };
export const directions = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
] as const;

export function createInitialState(forbiddenRules = false): GomokuState {
  return {
    rulesVersion,
    forbiddenRules,
    status: "playing",
    turn: "black",
    board: Array.from({ length: boardSize }, () => Array<Cell>(boardSize).fill(null)),
    moveNumber: 0,
    lastMove: null,
    eliminatedColors: [],
    result: null,
  };
}

export function inBounds({ x, y }: Position): boolean {
  return (
    Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < boardSize && y < boardSize
  );
}

export function countStones(board: Board): Record<Color, number> {
  const counts = { black: 0, white: 0 };
  for (const row of board) for (const cell of row) if (cell !== null) counts[cell]++;
  return counts;
}

export function lineThrough(
  board: Board,
  position: Position,
  color: Color,
  dx: number,
  dy: number,
): Position[] {
  const line: Position[] = [{ ...position }];
  for (const sign of [-1, 1]) {
    let x = position.x + dx * sign;
    let y = position.y + dy * sign;
    while (inBounds({ x, y }) && board[y][x] === color) {
      if (sign < 0) line.unshift({ x, y });
      else line.push({ x, y });
      x += dx * sign;
      y += dy * sign;
    }
  }
  return line;
}

export function winningLines(
  board: Board,
  position: Position,
  color: Color,
  forbiddenRules: boolean,
): Position[][] {
  return directions
    .map(([dx, dy]) => lineThrough(board, position, color, dx, dy))
    .filter((line) => (color === "black" && forbiddenRules ? line.length === 5 : line.length >= 5));
}

function finish(
  state: GomokuState,
  reason: GameResult["reason"],
  winner: Color | null,
  lines: Position[][] = [],
): GomokuState {
  return {
    ...state,
    status: "finished",
    turn: null,
    result: { reason, winner, stoneCounts: countStones(state.board), winningLines: lines },
  };
}

export function getLegalMovesForColor(state: GomokuState, color: Color): Position[] {
  if (state.status === "finished" || state.eliminatedColors.includes(color)) return [];
  return state.board.flatMap((row, y) =>
    row.flatMap((cell, x) => (cell === null ? [{ x, y }] : [])),
  );
}

export function getLegalMoves(state: GomokuState): Position[] {
  return state.status === "playing" ? getLegalMovesForColor(state, state.turn) : [];
}

export function applyAction(state: GomokuState, action: GomokuAction): ApplyActionResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  const { position } = action;
  if (!inBounds(position)) return { ok: false, reason: "out_of_bounds" };
  if (state.board[position.y][position.x] !== null) return { ok: false, reason: "occupied" };
  const board = state.board.map((row) => [...row]);
  board[position.y][position.x] = state.turn;
  const moved: GomokuState = {
    ...state,
    board,
    moveNumber: state.moveNumber + 1,
    lastMove: { ...position },
  };
  const lines = winningLines(board, position, state.turn, state.forbiddenRules);
  if (lines.length) return { ok: true, state: finish(moved, "five", state.turn, lines) };
  if (board.every((row) => row.every((cell) => cell !== null)))
    return { ok: true, state: finish(moved, "board_full", null) };
  return { ok: true, state: { ...moved, turn: state.turn === "black" ? "white" : "black" } };
}

export function eliminateColor(state: GomokuState, color: Color): ApplyActionResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  return {
    ok: true,
    state: finish(
      { ...state, eliminatedColors: [color] },
      "last_player",
      color === "black" ? "white" : "black",
    ),
  };
}
