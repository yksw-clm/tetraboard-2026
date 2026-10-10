export { replayDataEqual } from "./replayDataEqual";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  setDrawProposal,
  declareEnteringKing,
  getCheckState,
  getLegalActions,
  type ShogiState,
} from "@tetraboard/shogi";
import {
  shogiPublicStateSchema,
  type ShogiPublicState,
  type ShogiReplayEvent,
} from "@tetraboard/protocol";
import { shogiEliminationLabels, shogiSideNames } from "./standardShogiRoomPresentation";
import { shogiMoveNotation, shogiReplayLabel, type ReplayLabel } from "./shogiNotation";
export type ShogiReplayFrame = {
  event?: ShogiReplayEvent;
  label: string;
  accessibleLabel?: string;
  game: ShogiPublicState;
  checkState: ReturnType<typeof getCheckState>;
};

export function applyShogiReplayEvent(state: ShogiState, event: ShogiReplayEvent) {
  switch (event.type) {
    case "declaration":
      return declareEnteringKing(state, event.side);
    case "action":
      return applyAction(state, event.side, event.action);
    case "eliminate":
      return eliminateSide(state, event.side, event.reason);
    case "drawProposal":
      return setDrawProposal(state, event.side, event.proposed);
  }
}

export function createShogiReplayFrame(
  state: ShogiState,
  transition?: { before: ShogiState; event: ShogiReplayEvent },
): ShogiReplayFrame {
  const { repetitions: _repetitions, ...game } = state;
  const label = transition
    ? replayLabel(transition.event, state, transition.before)
    : { label: "開始局面" };
  return {
    ...label,
    game: shogiPublicStateSchema.parse(game),
    checkState: getCheckState(state),
    ...(transition ? { event: transition.event } : {}),
  };
}

function replayLabel(event: ShogiReplayEvent, state: ShogiState, before: ShogiState): ReplayLabel {
  const mark = { south: "▲", north: "△" }[event.side];
  const label = (text: string, moveNumber?: number) =>
    shogiReplayLabel(mark, shogiSideNames[event.side], text, moveNumber);
  if (event.type === "declaration") return label("入玉宣言");
  if (event.type === "drawProposal") return label(event.proposed ? "持将棋提案" : "持将棋取消");
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
    }),
    state.moveNumber,
  );
}

/** rulesVersion 1の再生境界。互換を壊す変更は別の版へ追加します。 */
export const shogiReplayV1 = {
  rulesVersion: 1,
  initialize: createInitialState,
  applyEvent: applyShogiReplayEvent,
  createFrame: createShogiReplayFrame,
} as const;
export function getShogiReplayRules(version: unknown) {
  if (version !== shogiReplayV1.rulesVersion)
    throw new Error("Unsupported Shogi replay rules version");
  return shogiReplayV1;
}
