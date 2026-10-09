import type { PendingStandardAction } from "./reversiSessionBehavior";
import type { GameId, RoomSocketClientMessage } from "@tetraboard/protocol";
import type { PendingReversiAction } from "./fourReversiSessionBehavior";
import type { PendingShogiAction } from "./fourShogiSessionBehavior";

/** 型だけの登録。ゲーム固有の判定・設定は各sessionからtransportへ渡す。 */
interface GameSessionTypeMap {
  reversi: { pending: PendingStandardAction; settings: never };
  "four-reversi": { pending: PendingReversiAction; settings: never };
  "four-shogi": {
    pending: PendingShogiAction;
    settings: Extract<RoomSocketClientMessage, { type: "room.three-player-attack.set" }>;
  };
}
export type PendingActionFor<G extends GameId> = GameSessionTypeMap[G]["pending"];
export type GameSettingsCommandFor<G extends GameId> = GameSessionTypeMap[G]["settings"];
