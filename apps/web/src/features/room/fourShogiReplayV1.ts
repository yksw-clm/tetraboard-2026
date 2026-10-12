export { replayDataEqual } from "./replayDataEqual";
import {
  applyAction,
  captureEliminatedHands,
  type EliminatedHands,
  createInitialState,
  eliminateSide,
  setDrawProposal,
  getCheckState,
  getLegalActions,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import {
  fourShogiPublicStateSchema,
  type FourShogiPublicState,
  type FourShogiReplayEvent,
} from "@tetraboard/protocol";
import { shogiEliminationLabels, shogiSideNames } from "./fourShogiRoomPresentation";
import { shogiMoveNotation, shogiReplayLabel, type ReplayLabel } from "./shogiNotation";
export type FourShogiReplayFrame = {
  event?: FourShogiReplayEvent;
  eliminatedHands?: EliminatedHands;
  label: string;
  accessibleLabel?: string;
  game: FourShogiPublicState;
  checkState: ReturnType<typeof getCheckState>;
};

export function applyFourShogiReplayEvent(state: FourShogiState, event: FourShogiReplayEvent) {
  switch (event.type) {
    case "action":
      return applyAction(state, event.side, event.action);
    case "eliminate":
      return eliminateSide(state, event.side, event.reason);
    case "drawProposal":
      return setDrawProposal(state, event.side, event.proposed);
  }
}

export function createFourShogiReplayFrame(
  state: FourShogiState,
  transition?: { before: FourShogiState; event: FourShogiReplayEvent },
): FourShogiReplayFrame {
  const { repetitions: _repetitions, ...game } = state;
  const label = transition
    ? replayLabel(transition.event, state, transition.before)
    : { label: "開始局面" };
  return {
    ...label,
    game: fourShogiPublicStateSchema.parse(game),
    checkState: getCheckState(state),
    ...(transition ? { event: transition.event } : {}),
  };
}

function replayLabel(
  event: FourShogiReplayEvent,
  state: FourShogiState,
  before: FourShogiState,
): ReplayLabel {
  const mark = shogiSideNames[event.side];
  const label = (text: string, moveNumber?: number) =>
    shogiReplayLabel(mark, shogiSideNames[event.side], text, moveNumber);
  if (event.type === "drawProposal") return label(event.proposed ? "引分提案" : "引分取消");
  if (event.type === "eliminate") return label(shogiEliminationLabels[event.reason]);
  const action = event.action;
  const piece =
    action.type === "dropPiece"
      ? { kind: action.pieceKind, promoted: false }
      : before.board[action.from.y][action.from.x];
  if (!piece) throw new Error("Replay move has no source piece");
  const legalMoves =
    action.type === "dropPiece"
      ? []
      : getLegalActions(before).flatMap((candidate) => {
          if (candidate.type !== "movePiece") return [];
          const source = before.board[candidate.from.y][candidate.from.x];
          if (!source) throw new Error("Legal move has no source piece");
          return [{ action: candidate, piece: source }];
        });
  return label(
    shogiMoveNotation({
      action,
      piece,
      legalMoves,
      previousDestination: before.lastMove?.action.to ?? null,
      side: event.side,
      allowDragonStraight: true,
    }),
    state.moveNumber,
  );
}

/** rulesVersion 1の再生境界。互換を壊す変更は別の版へ追加します。 */
export const fourShogiReplayV1 = {
  rulesVersion: 1,
  initialize: createInitialState,
  applyEvent: applyFourShogiReplayEvent,
  createFrame: createFourShogiReplayFrame,
} as const;
export function getFourShogiReplayRules(version: unknown) {
  if (version !== fourShogiReplayV1.rulesVersion)
    throw new Error("Unsupported Shogi replay rules version");
  return fourShogiReplayV1;
}

/** 表示情報を併走させ、版1のルール状態と最終局面照合を維持します。 */
export function getFourShogiDisplayReplayRules(version: unknown) {
  const rules = getFourShogiReplayRules(version);
  type State = { game: FourShogiState; hands: EliminatedHands };
  return {
    initialize: (initial: Parameters<typeof rules.initialize>[0]): State => ({
      game: rules.initialize(initial),
      hands: {},
    }),
    applyEvent: (before: State, event: FourShogiReplayEvent) => {
      const result = rules.applyEvent(before.game, event);
      if (!result.ok) return result;
      return {
        ok: true as const,
        state: {
          game: result.state,
          hands: captureEliminatedHands(before.hands, before.game, result.state),
        },
      };
    },
    createFrame: (
      state: State,
      transition?: { before: State; event: FourShogiReplayEvent },
    ): FourShogiReplayFrame => ({
      ...rules.createFrame(
        state.game,
        transition ? { before: transition.before.game, event: transition.event } : undefined,
      ),
      eliminatedHands: state.hands,
    }),
  };
}
