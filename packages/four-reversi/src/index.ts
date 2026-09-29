export const colors = ["black", "white", "red", "blue"] as const;

export type Color = (typeof colors)[number];
export type Cell = Color | null;
export type Position = { x: number; y: number };
export type GameMode = "singles" | "doubles";
export type Team = "black-red" | "white-blue";
export type EndReason = "board_full" | "all_passed" | "last_player" | "team_eliminated";

export type SinglesStanding = { color: Color; rank: number; stoneCount?: number };
export type GameResult =
  | {
      mode: "singles";
      reason: Exclude<EndReason, "team_eliminated">;
      standings: SinglesStanding[];
    }
  | {
      mode: "doubles";
      reason: Exclude<EndReason, "last_player">;
      winner: Team | null;
      stoneCounts: { color: Color; count: number }[];
      teamTotals: Record<Team, number> | null;
    };

type StateBase = {
  mode: GameMode;
  board: readonly (readonly Cell[])[];
  moveNumber: number;
  eliminatedColors: readonly Color[];
  consecutivePasses: readonly Color[];
};

export type FourReversiState =
  | (StateBase & { status: "playing"; turn: Color; result: null })
  | (StateBase & { status: "finished"; turn: null; result: GameResult });
export type FourReversiAction = { type: "placeStone"; position: Position };
export type MoveError =
  | "game_finished"
  | "out_of_bounds"
  | "occupied"
  | "no_capture"
  | "eliminates_player";
export type ApplyActionResult =
  | {
      ok: true;
      state: FourReversiState;
      flipped: readonly Position[];
      passedColors: readonly Color[];
    }
  | { ok: false; reason: MoveError };
export type EliminateColorResult =
  | { ok: true; state: FourReversiState; passedColors: readonly Color[] }
  | { ok: false; reason: "game_finished" | "already_eliminated" };

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

export function createInitialState(mode: GameMode): FourReversiState {
  return {
    mode,
    status: "playing",
    board: initialRows.map((row) => [...row].map((symbol) => symbolToCell[symbol])),
    turn: "black",
    moveNumber: 0,
    eliminatedColors: [],
    consecutivePasses: [],
    result: null,
  };
}

export function getActiveColors(state: FourReversiState): Color[] {
  return colors.filter((color) => !state.eliminatedColors.includes(color));
}

export function countStones(board: FourReversiState["board"]): Record<Color, number> {
  const counts: Record<Color, number> = { black: 0, white: 0, red: 0, blue: 0 };
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
  board: FourReversiState["board"],
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

function placeStone(
  board: FourReversiState["board"],
  color: Color,
  activeColors: readonly Color[],
  position: Position,
): Placement {
  if (!inBounds(position)) return { ok: false, reason: "out_of_bounds" };
  if (board[position.y][position.x] !== null) return { ok: false, reason: "occupied" };

  const flipped = capturedStones(board, color, position);
  if (flipped.length === 0) return { ok: false, reason: "no_capture" };

  const nextBoard = board.map((row) => [...row]);
  nextBoard[position.y][position.x] = color;
  for (const stone of flipped) nextBoard[stone.y][stone.x] = color;
  const counts = countStones(nextBoard);
  if (activeColors.some((other) => other !== color && counts[other] === 0)) {
    return { ok: false, reason: "eliminates_player" };
  }
  return { ok: true, board: nextBoard, flipped };
}

function legalMovesForColor(
  board: FourReversiState["board"],
  color: Color,
  activeColors: readonly Color[],
): Position[] {
  const moves: Position[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const position = { x, y };
      if (board[y][x] === null && placeStone(board, color, activeColors, position).ok) {
        moves.push(position);
      }
    }
  }
  return moves;
}

function boardIsFull(board: FourReversiState["board"]): boolean {
  return board.every((row) => row.every((cell) => cell !== null));
}

function teamForColor(color: Color): Team {
  return color === "black" || color === "red" ? "black-red" : "white-blue";
}

function finish(state: FourReversiState, reason: EndReason): FourReversiState {
  const counts = countStones(state.board);
  const active = getActiveColors(state);
  let result: GameResult;

  if (state.mode === "singles") {
    const surviving = active
      .map((color) => ({ color, stoneCount: counts[color] }))
      .sort((left, right) => right.stoneCount - left.stoneCount);
    const standings: SinglesStanding[] = [];
    for (const [index, player] of surviving.entries()) {
      const previous = surviving[index - 1];
      standings.push({
        ...player,
        rank: previous?.stoneCount === player.stoneCount ? standings[index - 1].rank : index + 1,
      });
    }
    for (const color of [...state.eliminatedColors].reverse()) {
      standings.push({ color, rank: standings.length + 1 });
    }
    result = {
      mode: "singles",
      reason: reason as Exclude<EndReason, "team_eliminated">,
      standings,
    };
  } else if (reason === "team_eliminated") {
    const eliminatedTeam = teamForColor(state.eliminatedColors.at(-1)!);
    result = {
      mode: "doubles",
      reason,
      winner: eliminatedTeam === "black-red" ? "white-blue" : "black-red",
      stoneCounts: active.map((color) => ({ color, count: counts[color] })),
      teamTotals: null,
    };
  } else {
    const teamTotals = {
      "black-red": counts.black + counts.red,
      "white-blue": counts.white + counts.blue,
    };
    result = {
      mode: "doubles",
      reason: reason as Exclude<EndReason, "last_player">,
      winner:
        teamTotals["black-red"] === teamTotals["white-blue"]
          ? null
          : teamTotals["black-red"] > teamTotals["white-blue"]
            ? "black-red"
            : "white-blue",
      stoneCounts: active.map((color) => ({ color, count: counts[color] })),
      teamTotals,
    };
  }
  return { ...state, status: "finished", turn: null, result };
}

function advanceTurn(
  state: FourReversiState,
  after: Color,
): {
  state: FourReversiState;
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
    if (legalMovesForColor(state.board, color, active).length > 0) {
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

export function applyAction(state: FourReversiState, action: FourReversiAction): ApplyActionResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  const placement = placeStone(state.board, state.turn, getActiveColors(state), action.position);
  if (!placement.ok) return { ok: false, reason: placement.reason };

  const moved: FourReversiState = {
    ...state,
    board: placement.board,
    moveNumber: state.moveNumber + 1,
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

export function getLegalMoves(state: FourReversiState): Position[] {
  return state.status === "finished"
    ? []
    : legalMovesForColor(state.board, state.turn, getActiveColors(state));
}

export function eliminateColor(state: FourReversiState, color: Color): EliminateColorResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  if (state.eliminatedColors.includes(color)) {
    return { ok: false, reason: "already_eliminated" };
  }
  const eliminated: FourReversiState = {
    ...state,
    eliminatedColors: [...state.eliminatedColors, color],
    consecutivePasses: state.consecutivePasses.filter((passed) => passed !== color),
  };
  if (state.mode === "doubles") {
    return { ok: true, state: finish(eliminated, "team_eliminated"), passedColors: [] };
  }
  if (getActiveColors(eliminated).length === 1) {
    return { ok: true, state: finish(eliminated, "last_player"), passedColors: [] };
  }
  if (state.turn !== color) {
    return { ok: true, state: eliminated, passedColors: [] };
  }
  return { ok: true, ...advanceTurn(eliminated, color) };
}
