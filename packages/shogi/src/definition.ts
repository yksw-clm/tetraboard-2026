import {
  defineGame,
  type EliminationReason,
  type GameActionResult,
} from "@tetraboard/game-contract";
import { shogiCatalog } from "./catalog";
import { shogiExternalCpu } from "./externalCpu";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  setDrawProposal,
  declareEnteringKing,
  declarationStatus,
  chooseCpuAction,
  type CpuLevel,
  type ShogiState,
  type ShogiAction,
  type Side,
  type InitialStateOptions,
  type GameResult,
  type MoveError,
  type RepetitionLookup,
} from "./index";
export { usiMove, createShogiAiRequest } from "./externalCpu";

export type ShogiGameAction =
  | ShogiAction
  | { type: "declaration" }
  | { type: "drawProposal"; proposed: boolean };
export type ShogiEvent =
  | { type: "action"; side: Side; action: ShogiAction }
  | { type: "declaration"; side: Side }
  | { type: "drawProposal"; side: Side; proposed: boolean }
  | { type: "eliminate"; side: Side; reason: EliminationReason };
export interface ShogiTypes {
  state: ShogiState;
  seat: Side;
  action: ShogiGameAction;
  event: ShogiEvent;
  settings: InitialStateOptions;
  result: GameResult;
  rejection: { type: MoveError };
  cpuLevel: CpuLevel;
  history: RepetitionLookup;
  replayInitial: InitialStateOptions;
  externalOptions: { moves: readonly string[]; nodes?: number; standardBook?: boolean };
  externalMove: string;
}

function apply(
  state: ShogiState,
  side: Side,
  action: ShogiGameAction,
  history?: RepetitionLookup,
): GameActionResult<ShogiState, ShogiEvent, ShogiTypes["rejection"]> {
  const result =
    action.type === "drawProposal"
      ? setDrawProposal(state, side, action.proposed)
      : action.type === "declaration"
        ? declareEnteringKing(state, side)
        : applyAction(state, side, action, history);
  if (!result.ok) return { ok: false, reason: { type: result.reason } };
  const event: ShogiEvent =
    action.type === "drawProposal"
      ? { type: "drawProposal", side, proposed: action.proposed }
      : action.type === "declaration"
        ? { type: "declaration", side }
        : { type: "action", side, action };
  return { ok: true, state: result.state, event };
}

function eliminate(state: ShogiState, side: Side, reason: EliminationReason) {
  const result = eliminateSide(state, side, reason);
  if (!result.ok) throw new Error(`Could not eliminate Shogi player: ${result.reason}`);
  return { state: result.state, event: { type: "eliminate" as const, side, reason } };
}

export const shogiDefinition = defineGame<ShogiTypes, "shogi">({
  catalog: shogiCatalog,
  rules: {
    createInitialState,
    getTurn: (state) => state.turn,
    getResult: (state) => state.result,
    applyAction: apply,
    eliminateSeat: eliminate,
    requiresTurn: (action) => action.type !== "drawProposal",
    endsTurn: (action) => action.type === "movePiece" || action.type === "dropPiece",
  },
  cpu: {
    external: shogiExternalCpu,
    chooseAction: (state, seat, level, random, history) => {
      if (state.status !== "playing" || state.turn !== seat) return null;
      const declaration = declarationStatus(state, seat);
      return declaration.eligible && declaration.outcome === "win"
        ? { type: "declaration" }
        : chooseCpuAction(state, level, random, history);
    },
  },
  replay: (initial, events) => {
    let state = createInitialState(initial);
    return events.map((event) => {
      const result =
        event.type === "eliminate"
          ? { ok: true as const, ...eliminate(state, event.side, event.reason) }
          : apply(state, event.side, event.type === "action" ? event.action : event);
      if (!result.ok) throw new Error(`Invalid Shogi replay action: ${result.reason.type}`);
      state = result.state;
      return state;
    });
  },
});
