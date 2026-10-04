import type { GameId } from "./games";
import type { FourReversiRoom, FourShogiRoom, RoomSocketClientMessage } from "./rooms";
import type { FourReversiMatchDetail, FourShogiMatchDetail } from "./matches";
import type { FourShogiAction } from "./fourShogi";
import type { FourReversiRankings, FourShogiRankings } from "./rankings";

type ReversiAction = Extract<
  Extract<RoomSocketClientMessage, { type: "room.game.action" }>["action"],
  { type: "placeStone" }
>;
/** 型だけの対応表。GameId の追加には各ゲームの具体型の登録が必要です。 */
export interface GameTypeMap {
  "four-reversi": {
    room: FourReversiRoom;
    match: FourReversiMatchDetail;
    action: ReversiAction;
    rankings: FourReversiRankings;
  };
  "four-shogi": {
    room: FourShogiRoom;
    match: FourShogiMatchDetail;
    action: FourShogiAction;
    rankings: FourShogiRankings;
  };
}
export type RoomFor<G extends GameId> = GameTypeMap[G]["room"];
export type MatchFor<G extends GameId> = GameTypeMap[G]["match"];
export type ActionFor<G extends GameId> = GameTypeMap[G]["action"];
export type RankingsFor<G extends GameId> = GameTypeMap[G]["rankings"];
export type GameActionCommandFor<G extends GameId> = G extends "four-shogi"
  ? { type: "room.game.action"; action: ActionFor<G>; roundId: string; positionRevision: number }
  : { type: "room.game.action"; action: ActionFor<G>; roundId?: never; positionRevision?: never };
export type GameCommandFor<G extends GameId> =
  | GameActionCommandFor<G>
  | Extract<RoomSocketClientMessage, { type: "room.game.start" | "room.game.resign" }>
  | (G extends "four-shogi"
      ? Extract<RoomSocketClientMessage, { type: "room.game.draw.set" }>
      : never);
