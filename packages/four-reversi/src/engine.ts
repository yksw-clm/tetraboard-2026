import {
  countStones,
  createPlacement,
  generatePlacements,
  type LegalPlacement,
  type SpendWork,
} from "./moves";
export { countStones } from "./moves";
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
  lastMove: Position | null;
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

export function createInitialState(mode: GameMode): FourReversiState {
  return {
    mode,
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

export function getActiveColors(state: FourReversiState): Color[] {
  return colors.filter((color) => !state.eliminatedColors.includes(color));
}

function legalMovesForColor(
  board: FourReversiState["board"],
  color: Color,
  activeColors: readonly Color[],
): Position[] {
  return generatePlacements(board, color, activeColors).map((placement) => placement.position);
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
  spend?: SpendWork,
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
    if (generatePlacements(state.board, color, active, true, spend).length > 0) {
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
  const placement = createPlacement(
    state.board,
    state.turn,
    getActiveColors(state),
    action.position,
  );
  if (!placement.ok) return { ok: false, reason: placement.reason };
  return applyLegalPlacement(state, placement.move);
}

export function getLegalPlacements(
  state: FourReversiState,
  color?: Color,
  spend?: SpendWork,
  firstOnly = false,
): LegalPlacement[] {
  if (state.status === "finished") return [];
  const selected = color ?? state.turn;
  if (state.eliminatedColors.includes(selected)) return [];
  return generatePlacements(state.board, selected, getActiveColors(state), firstOnly, spend);
}

export function applyLegalPlacement(
  state: FourReversiState,
  placement: LegalPlacement,
  spend?: SpendWork,
): Extract<ApplyActionResult, { ok: true }> {
  if (
    state.status !== "playing" ||
    state.board !== placement.sourceBoard ||
    state.turn !== placement.color ||
    getActiveColors(state).join(",") !== placement.activeKey
  )
    throw new TypeError("生成済み候補の元局面が一致しません");

  const moved: FourReversiState = {
    ...state,
    board: placement.board,
    moveNumber: state.moveNumber + 1,
    lastMove: { ...placement.position },
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
  const next = advanceTurn(moved, state.turn, spend);
  return { ok: true, ...next, flipped: placement.flipped };
}

export function getLegalMoves(state: FourReversiState): Position[] {
  return state.status === "finished"
    ? []
    : legalMovesForColor(state.board, state.turn, getActiveColors(state));
}

export function getLegalMovesForColor(state: FourReversiState, color: Color): Position[] {
  return state.status === "finished" || state.eliminatedColors.includes(color)
    ? []
    : legalMovesForColor(state.board, color, getActiveColors(state));
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
