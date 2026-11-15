import {
  defineGame,
  type EliminationReason,
  type GameActionResult,
} from "@tetraboard/game-contract";
import { fourShogiCatalog } from "./catalog";
import { fourShogiExternalCpu } from "./externalCpu";
import {
  applyAction,
  chooseCpuAction,
  createInitialState,
  eliminateSide,
  setDrawProposal,
  type CpuLevel,
  type FourShogiAction,
  type FourShogiState,
  type GameResult,
  type InitialStateOptions,
  type MoveError,
  type RepetitionLookup,
  type Side,
} from "./index";
import type { FourShogiReplayEvent } from "./replay";

export type FourShogiGameAction = FourShogiAction | { type: "drawProposal"; proposed: boolean };
export interface FourShogiTypes {
  state: FourShogiState;
  seat: Side;
  action: FourShogiGameAction;
  event: FourShogiReplayEvent;
  settings: InitialStateOptions;
  result: GameResult;
  rejection: { type: MoveError | "invalid_proposal" };
  cpuLevel: CpuLevel;
  history: RepetitionLookup;
  replayInitial: InitialStateOptions;
  externalOptions: {
    events: readonly FourShogiReplayEvent[];
    profile: { profileId: string };
  };
  externalMove: FourShogiAction;
}

function apply(
  state: FourShogiState,
  side: Side,
  action: FourShogiGameAction,
  history?: RepetitionLookup,
): GameActionResult<FourShogiState, FourShogiReplayEvent, FourShogiTypes["rejection"]> {
  const result =
    action.type === "drawProposal"
      ? setDrawProposal(state, side, action.proposed)
      : applyAction(state, side, action, history);
  if (!result.ok) return { ok: false, reason: { type: result.reason } };
  return {
    ok: true,
    state: result.state,
    event:
      action.type === "drawProposal"
        ? { type: "drawProposal", side, proposed: action.proposed }
        : { type: "action", side, action },
  };
}

function eliminate(
  state: FourShogiState,
  side: Side,
  reason: EliminationReason,
  history?: RepetitionLookup,
) {
  const result = eliminateSide(state, side, reason, history);
  if (!result.ok) throw new Error(`Could not eliminate FourShogi player: ${result.reason}`);
  return { state: result.state, event: { type: "eliminate" as const, side, reason } };
}

export const fourShogiDefinition = defineGame<FourShogiTypes, "four-shogi">({
  catalog: fourShogiCatalog,
  rules: {
    createInitialState,
    getTurn: (state) => state.turn,
    getResult: (state) => state.result,
    applyAction: apply,
    eliminateSeat: eliminate,
    requiresTurn: () => true,
    endsTurn: (action) => action.type !== "drawProposal",
  },
  cpu: {
    external: fourShogiExternalCpu,
    chooseAction: (state, seat, level, random, history) => {
      if (state.status !== "playing" || state.turn !== seat) return null;
      return chooseCpuAction(state, level, random, history);
    },
  },
  replay: (initial, events) => {
    let state = createInitialState(initial);
    return events.map((event) => {
      const result =
        event.type === "eliminate"
          ? { ok: true as const, ...eliminate(state, event.side, event.reason) }
          : apply(state, event.side, event.type === "action" ? event.action : event);
      if (!result.ok) throw new Error(`Invalid FourShogi replay action: ${result.reason.type}`);
      state = result.state;
      return state;
    });
  },
});
