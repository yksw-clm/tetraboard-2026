import {
  applyAction,
  createInitialState,
  eliminateSide,
  setDrawProposal,
  getCheckState,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import {
  fourShogiPublicStateSchema,
  type FourShogiPublicState,
  type FourShogiReplayEvent,
} from "@tetraboard/protocol";
import { shogiEliminationLabels, shogiSideNames } from "./fourShogiRoomPresentation";
export type FourShogiReplayFrame = {
  label: string;
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
  event?: FourShogiReplayEvent,
): FourShogiReplayFrame {
  const { repetitions: _repetitions, ...game } = state;
  const label = event ? replayLabel(event, state) : "開始局面";
  return { label, game: fourShogiPublicStateSchema.parse(game), checkState: getCheckState(state) };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function replayDataEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function replayLabel(event: FourShogiReplayEvent, state: FourShogiState): string {
  if (event.type === "drawProposal")
    return `${shogiSideNames[event.side]} ${event.proposed ? "引分提案" : "引分取消"}`;
  if (event.type === "eliminate")
    return `${shogiSideNames[event.side]} ${shogiEliminationLabels[event.reason]}`;
  const action = event.action;
  const destination = `${String.fromCharCode(65 + action.to.x)}${action.to.y + 1}`;
  const suffix = action.type === "dropPiece" ? "打" : action.promote ? "成" : "";
  const kind = action.type === "dropPiece" ? action.pieceKind : state.lastMove?.piece.kind;
  const names = { pawn: "歩", silver: "銀", gold: "金", rook: "飛", king: "王" } as const;
  return `${state.moveNumber}: ${shogiSideNames[event.side]}${destination}${kind ? names[kind] : ""}${suffix}`;
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
