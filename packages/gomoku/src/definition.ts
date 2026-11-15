import {
  defineGame,
  type EliminationReason,
  type GameActionResult,
  type GameTransition,
} from "@tetraboard/game-contract";
import { gomokuCatalog, type GomokuSettings } from "./catalog";
import { chooseCpuMove, type CpuLevel } from "./cpu";
import {
  applyAction,
  createInitialState,
  eliminateColor,
  type ApplyActionResult,
  type Color,
  type ForbiddenReason,
  type GameResult,
  type GomokuAction,
  type GomokuState,
  type Position,
} from "./index";
import { sameState } from "./replay";

export type GomokuEvent =
  | { type: "place"; color: Color; position: Position }
  | { type: "eliminate"; color: Color; reason: EliminationReason };
export type GomokuRejection =
  | { type: Exclude<Extract<ApplyActionResult, { ok: false }>["reason"], "forbidden"> }
  | { type: "not_your_turn" }
  | { type: "forbidden"; forbidden: readonly ForbiddenReason[] };
export interface GomokuTypes {
  state: GomokuState;
  seat: Color;
  action: GomokuAction;
  event: GomokuEvent;
  settings: GomokuSettings;
  result: GameResult;
  rejection: GomokuRejection;
  cpuLevel: CpuLevel;
}

function apply(
  state: GomokuState,
  seat: Color,
  action: GomokuAction,
): GameActionResult<GomokuState, GomokuEvent, GomokuRejection> {
  if (state.status === "finished") return { ok: false, reason: { type: "game_finished" } };
  if (seat !== state.turn) return { ok: false, reason: { type: "not_your_turn" } };
  const result = applyAction(state, action);
  if (!result.ok)
    return {
      ok: false,
      reason:
        result.reason === "forbidden"
          ? { type: "forbidden", forbidden: result.forbidden }
          : { type: result.reason },
    };
  return {
    ok: true,
    state: result.state,
    event: { type: "place", color: seat, position: { ...action.position } },
  };
}

function eliminate(
  state: GomokuState,
  color: Color,
  reason: EliminationReason,
): GameTransition<GomokuState, GomokuEvent> {
  const result = eliminateColor(state, color);
  if (!result.ok) throw new Error("Could not eliminate Gomoku player");
  return { state: result.state, event: { type: "eliminate", color, reason } };
}

function replay(initial: GomokuState, events: readonly GomokuEvent[]): GomokuState[] {
  let state = createInitialState(initial.forbiddenRules);
  if (!sameState(state, initial)) throw new Error("Invalid Gomoku initial state");
  return events.map((event) => {
    if (state.status !== "playing" || (event.type === "place" && event.color !== state.turn))
      throw new Error("Invalid Gomoku turn");
    const result =
      event.type === "place"
        ? apply(state, event.color, { type: "placeStone", position: event.position })
        : { ok: true as const, ...eliminate(state, event.color, event.reason) };
    if (!result.ok) throw new Error("Invalid Gomoku replay action");
    state = result.state;
    return state;
  });
}

export const gomokuDefinition = defineGame<GomokuTypes, "gomoku">({
  catalog: gomokuCatalog,
  rules: {
    createInitialState: (settings) => createInitialState(settings.forbiddenRules),
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
