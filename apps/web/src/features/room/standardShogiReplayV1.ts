export { replayDataEqual } from "./replayDataEqual";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  setDrawProposal,
  declareEnteringKing,
  getCheckState,
  type ShogiState,
} from "@tetraboard/shogi";
import {
  shogiPublicStateSchema,
  type ShogiPublicState,
  type ShogiReplayEvent,
} from "@tetraboard/protocol";
import { shogiEliminationLabels, shogiSideNames } from "./standardShogiRoomPresentation";
export type ShogiReplayFrame = {
  event?: ShogiReplayEvent;
  label: string;
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
  event?: ShogiReplayEvent,
): ShogiReplayFrame {
  const { repetitions: _repetitions, ...game } = state;
  const label = event ? replayLabel(event, state) : "開始局面";
  return {
    label,
    game: shogiPublicStateSchema.parse(game),
    checkState: getCheckState(state),
    ...(event ? { event } : {}),
  };
}

function replayLabel(event: ShogiReplayEvent, state: ShogiState): string {
  if (event.type === "declaration") return `${shogiSideNames[event.side]} 入玉宣言`;
  if (event.type === "drawProposal")
    return `${shogiSideNames[event.side]} ${event.proposed ? "持将棋提案" : "持将棋取消"}`;
  if (event.type === "eliminate")
    return `${shogiSideNames[event.side]} ${shogiEliminationLabels[event.reason]}`;
  const action = event.action;
  const destination = `${String.fromCharCode(65 + action.to.x)}${action.to.y + 1}`;
  const suffix = action.type === "dropPiece" ? "打" : action.promote ? "成" : "";
  const kind = action.type === "dropPiece" ? action.pieceKind : state.lastMove?.piece.kind;
  const names = {
    bishop: "角",
    knight: "桂",
    lance: "香",
    pawn: "歩",
    silver: "銀",
    gold: "金",
    rook: "飛",
    king: "王",
  } as const;
  return `${state.moveNumber}: ${shogiSideNames[event.side]}${destination}${kind ? names[kind] : ""}${suffix}`;
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
