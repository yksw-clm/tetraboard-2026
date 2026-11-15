import {
  defineGame,
  type EliminationReason,
  type GameActionResult,
  type GameTransition,
} from "@tetraboard/game-contract";
import { fourGomokuCatalog, type FourGomokuSettings } from "./catalog";
import { chooseCpuMove, type CpuLevel } from "./cpu";
import {
  applyAction,
  createInitialState,
  eliminateColor,
  type ActionResult,
  type Color,
  type GameResult,
  type FourGomokuState,
  type Position,
} from "./index";
import { sameState } from "./replay";

export type FourGomokuEvent =
  | { type: "place"; color: Color; position: Position }
  | { type: "eliminate"; color: Color; reason: EliminationReason };
export type FourGomokuAction = { type: "placeStone"; position: Position };
export type FourGomokuRejection = {
  type: Extract<ActionResult, { ok: false }>["reason"] | "not_your_turn";
};
export interface FourGomokuTypes {
  state: FourGomokuState;
  seat: Color;
  action: FourGomokuAction;
  event: FourGomokuEvent;
  settings: FourGomokuSettings;
  result: GameResult;
  rejection: FourGomokuRejection;
  cpuLevel: CpuLevel;
}

function apply(
  state: FourGomokuState,
  seat: Color,
  action: FourGomokuAction,
): GameActionResult<FourGomokuState, FourGomokuEvent, FourGomokuRejection> {
  if (state.status === "finished") return { ok: false, reason: { type: "game_finished" } };
  if (seat !== state.turn) return { ok: false, reason: { type: "not_your_turn" } };
  const result = applyAction(state, action);
  if (!result.ok) return { ok: false, reason: { type: result.reason } };
  return {
    ok: true,
    state: result.state,
    event: { type: "place", color: seat, position: { ...action.position } },
  };
}

function eliminate(
  state: FourGomokuState,
  color: Color,
  reason: EliminationReason,
): GameTransition<FourGomokuState, FourGomokuEvent> {
  const result = eliminateColor(state, color, reason);
  if (!result.ok) throw new Error("Could not eliminate Four Gomoku player");
  return { state: result.state, event: { type: "eliminate", color, reason } };
}

function replay(initial: FourGomokuState, events: readonly FourGomokuEvent[]): FourGomokuState[] {
  let state = createInitialState(initial.mode);
  if (!sameState(state, initial)) throw new Error("Invalid Four Gomoku initial state");
  return events.map((event) => {
    if (state.status !== "playing" || (event.type === "place" && event.color !== state.turn))
      throw new Error("Invalid Four Gomoku turn");
    const result =
      event.type === "place"
        ? apply(state, event.color, { type: "placeStone", position: event.position })
        : { ok: true as const, ...eliminate(state, event.color, event.reason) };
    if (!result.ok) throw new Error("Invalid Four Gomoku replay action");
    state = result.state;
    return state;
  });
}

export const fourGomokuDefinition = defineGame<FourGomokuTypes, "four-gomoku">({
  catalog: fourGomokuCatalog,
  rules: {
    createInitialState: (settings) => createInitialState(settings.mode),
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
