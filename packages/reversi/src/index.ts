export const colors = ["black", "white"] as const;

export type Color = (typeof colors)[number];
export type Cell = Color | null;
export type Position = { x: number; y: number };
export type EndReason = "board_full" | "all_passed" | "last_player";
export type GameResult = {
  reason: EndReason;
  winner: Color | null;
  stoneCounts: Record<Color, number>;
};

type StateBase = {
  board: readonly (readonly Cell[])[];
  moveNumber: number;
  lastMove: Position | null;
  eliminatedColors: readonly Color[];
  consecutivePasses: readonly Color[];
};

export type ReversiState =
  | (StateBase & { status: "playing"; turn: Color; result: null })
  | (StateBase & { status: "finished"; turn: null; result: GameResult });
export type ReversiAction = { type: "placeStone"; position: Position };
export type MoveError = "game_finished" | "out_of_bounds" | "occupied" | "no_capture";
export type ApplyActionResult =
  | {
      ok: true;
      state: ReversiState;
      flipped: readonly Position[];
      passedColors: readonly Color[];
    }
  | { ok: false; reason: MoveError };
export type EliminateColorResult =
  | { ok: true; state: ReversiState; passedColors: readonly Color[] }
  | { ok: false; reason: "game_finished" | "already_eliminated" };

const initialRows = [
  "........",
  "........",
  "........",
  "...WK...",
  "...KW...",
  "........",
  "........",
  "........",
];
const symbolToCell: Record<string, Cell> = { ".": null, K: "black", W: "white" };
const directions = [-1, 0, 1].flatMap((dy) =>
  [-1, 0, 1].filter((dx) => dx !== 0 || dy !== 0).map((dx) => ({ dx, dy })),
);

export function createInitialState(): ReversiState {
  return {
    status: "playing",
    board: initialRows.map((row) => [...row].map((symbol) => symbolToCell[symbol])),
    turn: "black",
    moveNumber: 0,
    lastMove: null,
    eliminatedColors: [],
    consecutivePasses: [],
    result: null,
  };
}

export function getActiveColors(state: ReversiState): Color[] {
  return colors.filter((color) => !state.eliminatedColors.includes(color));
}

export function countStones(board: ReversiState["board"]): Record<Color, number> {
  const counts: Record<Color, number> = { black: 0, white: 0 };
  for (const row of board) {
    for (const cell of row) {
      if (cell !== null) counts[cell]++;
    }
  }
  return counts;
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

function capturedStones(
  board: ReversiState["board"],
  color: Color,
  position: Position,
): Position[] {
  const captured: Position[] = [];
  for (const { dx, dy } of directions) {
    const line: Position[] = [];
    let x = position.x + dx;
    let y = position.y + dy;
    while (x >= 0 && x < 8 && y >= 0 && y < 8) {
      const cell = board[y][x];
      if (cell === null) break;
      if (cell === color) {
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

type Placement =
  | { ok: true; board: Cell[][]; flipped: Position[] }
  | { ok: false; reason: Exclude<MoveError, "game_finished"> };

function placeStone(board: ReversiState["board"], color: Color, position: Position): Placement {
  if (!inBounds(position)) return { ok: false, reason: "out_of_bounds" };
  if (board[position.y][position.x] !== null) return { ok: false, reason: "occupied" };

  const flipped = capturedStones(board, color, position);
  if (flipped.length === 0) return { ok: false, reason: "no_capture" };

  const nextBoard = board.map((row) => [...row]);
  nextBoard[position.y][position.x] = color;
  for (const stone of flipped) nextBoard[stone.y][stone.x] = color;
  return { ok: true, board: nextBoard, flipped };
}

function legalMovesForColor(board: ReversiState["board"], color: Color): Position[] {
  const moves: Position[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const position = { x, y };
      if (board[y][x] === null && placeStone(board, color, position).ok) {
        moves.push(position);
      }
    }
  }
  return moves;
}

function boardIsFull(board: ReversiState["board"]): boolean {
  return board.every((row) => row.every((cell) => cell !== null));
}

function finish(state: ReversiState, reason: EndReason): ReversiState {
  const stoneCounts = countStones(state.board);
  const winner =
    reason === "last_player"
      ? getActiveColors(state)[0]
      : stoneCounts.black === stoneCounts.white
        ? null
        : stoneCounts.black > stoneCounts.white
          ? "black"
          : "white";
  return { ...state, status: "finished", turn: null, result: { reason, winner, stoneCounts } };
}

function advanceTurn(
  state: ReversiState,
  after: Color,
): {
  state: ReversiState;
  passedColors: Color[];
} {
  if (state.status === "finished") return { state, passedColors: [] };
  const active = getActiveColors(state);
  const passedColors: Color[] = [];
  let consecutivePasses = [...state.consecutivePasses];
  let index = colors.indexOf(after);

  for (;;) {
    index = (index + 1) % colors.length;
    const color = colors[index];
    if (!active.includes(color)) continue;
    if (legalMovesForColor(state.board, color).length > 0) {
      return {
        state: { ...state, turn: color, consecutivePasses },
        passedColors,
      };
    }
    passedColors.push(color);
    consecutivePasses.push(color);
    if (consecutivePasses.length === active.length) {
      return {
        state: finish({ ...state, consecutivePasses }, "all_passed"),
        passedColors,
      };
    }
  }
}

export function applyAction(state: ReversiState, action: ReversiAction): ApplyActionResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  const placement = placeStone(state.board, state.turn, action.position);
  if (!placement.ok) return { ok: false, reason: placement.reason };

  const moved: ReversiState = {
    ...state,
    board: placement.board,
    moveNumber: state.moveNumber + 1,
    lastMove: { ...action.position },
    consecutivePasses: [],
  };
  if (boardIsFull(moved.board)) {
    return {
      ok: true,
      state: finish(moved, "board_full"),
      flipped: placement.flipped,
      passedColors: [],
    };
  }
  const next = advanceTurn(moved, state.turn);
  return { ok: true, ...next, flipped: placement.flipped };
}

export function getLegalMoves(state: ReversiState): Position[] {
  return state.status === "finished" ? [] : legalMovesForColor(state.board, state.turn);
}

export function getLegalMovesForColor(state: ReversiState, color: Color): Position[] {
  return state.status === "finished" || state.eliminatedColors.includes(color)
    ? []
    : legalMovesForColor(state.board, color);
}

export function eliminateColor(state: ReversiState, color: Color): EliminateColorResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  if (state.eliminatedColors.includes(color)) {
    return { ok: false, reason: "already_eliminated" };
  }
  const eliminated: ReversiState = {
    ...state,
    eliminatedColors: [...state.eliminatedColors, color],
    consecutivePasses: state.consecutivePasses.filter((passed) => passed !== color),
  };
  if (getActiveColors(eliminated).length === 1) {
    return { ok: true, state: finish(eliminated, "last_player"), passedColors: [] };
  }
  if (state.turn !== color) {
    return { ok: true, state: eliminated, passedColors: [] };
  }
  return { ok: true, ...advanceTurn(eliminated, color) };
}

export { chooseCpuMove } from "./cpu";
export type { CpuLevel } from "./cpu";
