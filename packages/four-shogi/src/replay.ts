import { applyAction, eliminateSide, setDrawProposal } from "./index";
import type { ExternalEliminationReason, FourShogiAction, FourShogiState, Side } from "./types";

export type FourShogiReplayEvent =
  | Readonly<{ type: "action"; side: Side; action: FourShogiAction }>
  | Readonly<{ type: "eliminate"; side: Side; reason: ExternalEliminationReason }>
  | Readonly<{ type: "drawProposal"; side: Side; proposed: boolean }>;

/** 表示と解析でイベントの裁定を共有し、保存・通信には触れません。 */
export function applyReplayEvent(state: FourShogiState, event: FourShogiReplayEvent) {
  switch (event.type) {
    case "action":
      return applyAction(state, event.side, event.action);
    case "eliminate":
      return eliminateSide(state, event.side, event.reason);
    case "drawProposal":
      return setDrawProposal(state, event.side, event.proposed);
  }
}
