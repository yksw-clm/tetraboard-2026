export const boardSize = 15;
export const rulesVersion = 1;
export const colors = ["black", "white", "red", "blue"] as const;
export type Color = (typeof colors)[number];
export type Cell = Color | null;
export type Position = { x: number; y: number };
export type Board = readonly (readonly Cell[])[];
export type GameMode = "singles" | "doubles";
export type Team = "black-red" | "white-blue";
export type EliminationReason = "resigned" | "left" | "timeout" | "disconnected";
export type Standing = {
  color: Color;
  rank: number;
  reason: EliminationReason | "five" | "last_player" | "board_full";
};
export type GameResult =
  | { mode: "singles"; reason: "ranked" | "last_player" | "board_full"; standings: Standing[] }
  | { mode: "doubles"; reason: "five" | "team_eliminated" | "board_full"; winner: Team | null };
type StateBase = {
  rulesVersion: typeof rulesVersion;
  mode: GameMode;
  board: Board;
  moveNumber: number;
  lastMove: Position | null;
  eliminatedColors: readonly Color[];
  completedColors: readonly Color[];
  standings: readonly Standing[];
  winningLines: readonly Position[][];
};
export type FourGomokuState =
  | (StateBase & { status: "playing"; turn: Color; result: null })
  | (StateBase & { status: "finished"; turn: null; result: GameResult });
export type ActionResult =
  | { ok: true; state: FourGomokuState }
  | { ok: false; reason: "game_finished" | "out_of_bounds" | "occupied" | "already_eliminated" };
export const directions = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
] as const;

export function createInitialState(mode: GameMode = "singles"): FourGomokuState {
  return {
    rulesVersion,
    mode,
    board: Array.from({ length: boardSize }, () => Array<Cell>(boardSize).fill(null)),
    moveNumber: 0,
    lastMove: null,
    eliminatedColors: [],
    completedColors: [],
    standings: [],
    winningLines: [],
    status: "playing",
    turn: "black",
    result: null,
  };
}
export function teamForColor(color: Color): Team {
  return color === "black" || color === "red" ? "black-red" : "white-blue";
}
export function isAlly(mode: GameMode, a: Color, b: Color): boolean {
  return mode === "doubles" ? teamForColor(a) === teamForColor(b) : a === b;
}
export function getActiveColors(state: FourGomokuState): Color[] {
  return colors.filter(
    (c) => !state.eliminatedColors.includes(c) && !state.completedColors.includes(c),
  );
}
export function inBounds({ x, y }: Position): boolean {
  return (
    Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < boardSize && y < boardSize
  );
}
/** 空点への仮想着手も評価できるよう、中心を自陣営の石として数えます。 */
export function winningLines(
  board: Board,
  position: Position,
  color: Color,
  mode: GameMode,
): Position[][] {
  return directions
    .map(([dx, dy]) => {
      const line = [{ ...position }];
      for (const sign of [-1, 1]) {
        let x = position.x + dx * sign,
          y = position.y + dy * sign;
        while (inBounds({ x, y })) {
          const cell = board[y][x];
          if (cell === null || !isAlly(mode, color, cell)) break;
          if (sign < 0) line.unshift({ x, y });
          else line.push({ x, y });
          x += dx * sign;
          y += dy * sign;
        }
      }
      return line;
    })
    .filter((line) => line.length >= 5);
}
export function getLegalMoves(state: FourGomokuState): Position[] {
  if (state.status === "finished") return [];
  return state.board.flatMap((row, y) =>
    row.flatMap((cell, x) => (cell === null ? [{ x, y }] : [])),
  );
}
function unassignedRanks(state: FourGomokuState): number[] {
  return [1, 2, 3, 4].filter((rank) => !state.standings.some((s) => s.rank === rank));
}
function finish(state: FourGomokuState, result: GameResult): FourGomokuState {
  return { ...state, status: "finished", turn: null, result };
}
function settle(
  state: FourGomokuState,
  after: Color,
  reason: "ranked" | "last_player",
): FourGomokuState {
  const active = getActiveColors(state);
  if (state.mode === "singles" && active.length === 1) {
    const standings = [
      ...state.standings,
      { color: active[0], rank: unassignedRanks(state)[0], reason: "last_player" as const },
    ].sort((a, b) => a.rank - b.rank);
    return finish({ ...state, standings }, { mode: "singles", reason, standings });
  }
  if (state.board.every((row) => row.every((cell) => cell !== null))) {
    if (state.mode === "doubles")
      return finish(state, { mode: "doubles", reason: "board_full", winner: null });
    const rank = unassignedRanks(state)[0];
    const standings = [
      ...state.standings,
      ...active.map((color) => ({ color, rank, reason: "board_full" as const })),
    ].sort((a, b) => a.rank - b.rank);
    return finish({ ...state, standings }, { mode: "singles", reason: "board_full", standings });
  }
  for (let i = 1; i <= colors.length; i++) {
    const turn = colors[(colors.indexOf(after) + i) % colors.length];
    if (active.includes(turn)) return { ...state, status: "playing", turn, result: null };
  }
  throw new Error("No active Four Gomoku player");
}
export function applyAction(
  state: FourGomokuState,
  action: { type: "placeStone"; position: Position },
): ActionResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  const { position } = action;
  if (!inBounds(position)) return { ok: false, reason: "out_of_bounds" };
  if (state.board[position.y][position.x] !== null) return { ok: false, reason: "occupied" };
  const board = state.board.map((row) => [...row]);
  board[position.y][position.x] = state.turn;
  const lines = winningLines(board, position, state.turn, state.mode);
  let next: FourGomokuState = {
    ...state,
    board,
    moveNumber: state.moveNumber + 1,
    lastMove: { ...position },
    winningLines: [...state.winningLines, ...lines],
  };
  if (lines.length) {
    if (state.mode === "doubles")
      return {
        ok: true,
        state: finish(next, { mode: "doubles", reason: "five", winner: teamForColor(state.turn) }),
      };
    next = {
      ...next,
      completedColors: [...state.completedColors, state.turn],
      standings: [
        ...state.standings,
        { color: state.turn, rank: unassignedRanks(state)[0], reason: "five" },
      ],
    };
  }
  return { ok: true, state: settle(next, state.turn, "ranked") };
}
export function eliminateColor(
  state: FourGomokuState,
  color: Color,
  reason: EliminationReason = "resigned",
): ActionResult {
  if (state.status === "finished") return { ok: false, reason: "game_finished" };
  if (!getActiveColors(state).includes(color)) return { ok: false, reason: "already_eliminated" };
  const next: FourGomokuState = { ...state, eliminatedColors: [...state.eliminatedColors, color] };
  if (state.mode === "doubles")
    return {
      ok: true,
      state: finish(next, {
        mode: "doubles",
        reason: "team_eliminated",
        winner: teamForColor(color) === "black-red" ? "white-blue" : "black-red",
      }),
    };
  const ranked: FourGomokuState = {
    ...next,
    standings: [...state.standings, { color, rank: unassignedRanks(state).at(-1)!, reason }],
  };
  if (getActiveColors(ranked).length === 1 || state.turn === color)
    return { ok: true, state: settle(ranked, state.turn, "last_player") };
  return { ok: true, state: ranked };
}
