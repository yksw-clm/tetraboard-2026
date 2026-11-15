import {
  defineGame,
  type EliminationReason,
  type GameActionResult,
  type GameTransition,
} from "@tetraboard/game-contract";
import { fourReversiExternalCpu } from "./externalCpu";
import { fourReversiCatalog, type FourReversiSettings } from "./catalog";
import {
  applyAction,
  createInitialState,
  eliminateColor,
  chooseCpuMove,
  type Color,
  type Position,
  type FourReversiState,
  type FourReversiAction,
  type GameResult,
  type MoveError,
  type CpuLevel,
} from "./index";

export type FourReversiEvent = (
  | { type: "place"; color: Color; position: Position }
  | { type: "eliminate"; color: Color; reason: EliminationReason }
) & { passedColors: readonly Color[] };
export type FourReversiRejection = { type: MoveError | "not_your_turn" };
export interface FourReversiTypes {
  state: FourReversiState;
  seat: Color;
  action: FourReversiAction;
  event: FourReversiEvent;
  settings: FourReversiSettings;
  result: GameResult;
  rejection: FourReversiRejection;
  cpuLevel: CpuLevel;
  externalOptions: { extendedRules?: boolean };
  externalMove: Position;
}

function apply(
  state: FourReversiState,
  seat: Color,
  action: FourReversiAction,
): GameActionResult<FourReversiState, FourReversiEvent, FourReversiRejection> {
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
  state: FourReversiState,
  color: Color,
  reason: EliminationReason,
): GameTransition<FourReversiState, FourReversiEvent> {
  const result = eliminateColor(state, color);
  if (!result.ok) throw new Error("Could not eliminate FourReversi player");
  return {
    state: result.state,
    event: { type: "eliminate", color, reason, passedColors: result.passedColors },
  };
}

function replay(
  initial: FourReversiState,
  events: readonly FourReversiEvent[],
): FourReversiState[] {
  let state = createInitialState(initial.mode);
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
    throw new Error("Invalid FourReversi initial state");
  return events.map((event) => {
    const result =
      event.type === "place"
        ? apply(state, event.color, { type: "placeStone", position: event.position })
        : { ok: true as const, ...eliminate(state, event.color, event.reason) };
    if (
      !result.ok ||
      JSON.stringify(result.event.passedColors) !== JSON.stringify(event.passedColors)
    )
      throw new Error("Invalid FourReversi replay action");
    state = result.state;
    return state;
  });
}

export const fourReversiDefinition = defineGame<FourReversiTypes, "four-reversi">({
  catalog: fourReversiCatalog,
  rules: {
    createInitialState: (settings) => createInitialState(settings.mode),
    getTurn: (state) => state.turn,
    applyAction: apply,
    eliminateSeat: eliminate,
    getResult: (state) => state.result,
  },
  cpu: {
    external: fourReversiExternalCpu,
    chooseAction: (state, seat, level, random) => {
      if (state.turn !== seat) return null;
      const position = chooseCpuMove(state, level, random);
      return position === null ? null : { type: "placeStone", position };
    },
  },
  replay,
});
