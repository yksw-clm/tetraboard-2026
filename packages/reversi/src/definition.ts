import {
  defineGame,
  type EliminationReason,
  type GameActionResult,
  type GameTransition,
} from "@tetraboard/game-contract";
import { reversiCatalog, type ReversiSettings } from "./catalog";
import {
  applyAction,
  createInitialState,
  eliminateColor,
  chooseCpuMove,
  type Color,
  type Position,
  type ReversiState,
  type ReversiAction,
  type GameResult,
  type MoveError,
  type CpuLevel,
} from "./index";

export type ReversiEvent = (
  | { type: "place"; color: Color; position: Position }
  | { type: "eliminate"; color: Color; reason: EliminationReason }
) & { passedColors: readonly Color[] };
export type ReversiRejection = { type: MoveError | "not_your_turn" };
export interface ReversiTypes {
  state: ReversiState;
  seat: Color;
  action: ReversiAction;
  event: ReversiEvent;
  settings: ReversiSettings;
  result: GameResult;
  rejection: ReversiRejection;
  cpuLevel: CpuLevel;
}

function apply(
  state: ReversiState,
  seat: Color,
  action: ReversiAction,
): GameActionResult<ReversiState, ReversiEvent, ReversiRejection> {
  if (state.status === "finished") return { ok: false, reason: { type: "game_finished" } };
  if (seat !== state.turn) return { ok: false, reason: { type: "not_your_turn" } };
  const result = applyAction(state, action);
  if (!result.ok) return { ok: false, reason: { type: result.reason } };
  return {
    ok: true,
    state: result.state,
    event: {
      type: "place",
      color: seat,
      position: { ...action.position },
      passedColors: result.passedColors,
    },
  };
}

function eliminate(
  state: ReversiState,
  color: Color,
  reason: EliminationReason,
): GameTransition<ReversiState, ReversiEvent> {
  const result = eliminateColor(state, color);
  if (!result.ok) throw new Error("Could not eliminate Reversi player");
  return {
    state: result.state,
    event: { type: "eliminate", color, reason, passedColors: result.passedColors },
  };
}

function replay(initial: ReversiState, events: readonly ReversiEvent[]): ReversiState[] {
  let state = createInitialState();
  if (
    initial.status !== state.status ||
    initial.turn !== state.turn ||
    initial.moveNumber !== 0 ||
    initial.lastMove !== null ||
    initial.result !== null ||
    initial.eliminatedColors.length !== 0 ||
    initial.consecutivePasses.length !== 0 ||
    JSON.stringify(initial.board) !== JSON.stringify(state.board)
  )
    throw new Error("Invalid Reversi initial state");
  return events.map((event) => {
    const result =
      event.type === "place"
        ? apply(state, event.color, { type: "placeStone", position: event.position })
        : { ok: true as const, ...eliminate(state, event.color, event.reason) };
    if (
      !result.ok ||
      JSON.stringify(result.event.passedColors) !== JSON.stringify(event.passedColors)
    )
      throw new Error("Invalid Reversi replay action");
    state = result.state;
    return state;
  });
}

export const reversiDefinition = defineGame<ReversiTypes, "reversi">({
  catalog: reversiCatalog,
  rules: {
    createInitialState: () => createInitialState(),
    getTurn: (state) => state.turn,
    applyAction: apply,
    eliminateSeat: eliminate,
    getResult: (state) => state.result,
  },
  cpu: {
    chooseAction: (state, seat, level, random) => {
      if (state.turn !== seat) return null;
      const position = chooseCpuMove(state, level, random);
      return position === null ? null : { type: "placeStone", position };
    },
  },
  replay,
});
