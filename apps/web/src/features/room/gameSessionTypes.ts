import type { PendingGomokuAction } from "./gomokuSessionBehavior";
import type { PendingStandardAction } from "./reversiSessionBehavior";
import type { GameId, RoomSocketClientMessage } from "@tetraboard/protocol";
import type { PendingReversiAction } from "./fourReversiSessionBehavior";
import type { PendingShogiAction } from "./fourShogiSessionBehavior";

/** 型だけの登録。ゲーム固有の判定・設定は各sessionからtransportへ渡す。 */
interface GameSessionTypeMap {
  gomoku: {
    pending: PendingGomokuAction;
    settings: Extract<RoomSocketClientMessage, { type: "room.gomoku-forbidden.set" }>;
  };
  shogi: { pending: PendingShogiAction; settings: never };
  reversi: { pending: PendingStandardAction; settings: never };
  "four-reversi": { pending: PendingReversiAction; settings: never };
  "four-shogi": {
    pending: PendingShogiAction;
    settings: Extract<RoomSocketClientMessage, { type: "room.three-player-attack.set" }>;
  };
}
export type PendingActionFor<G extends GameId> = GameSessionTypeMap[G]["pending"];
export type GameSettingsCommandFor<G extends GameId> = GameSessionTypeMap[G]["settings"];
