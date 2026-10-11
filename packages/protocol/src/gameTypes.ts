import type { FourGomokuRoom } from "./rooms";
import type { FourGomokuMatchDetail, PublicFourGomokuMatchDetail } from "./matches";
import type { GomokuRoom } from "./rooms";
import type { GomokuMatchDetail, PublicGomokuMatchDetail } from "./matches";
import type { ShogiRoom } from "./rooms";
import type { ShogiMatchDetail, PublicShogiMatchDetail } from "./matches";
import type { ShogiAction } from "./shogi";
import type { ReversiRoom } from "./rooms";
import type { ReversiMatchDetail, PublicReversiMatchDetail } from "./matches";
import type { ReversiRankings } from "./rankings";
import type { GameId } from "./games";
import type { FourReversiRoom, FourShogiRoom, RoomSocketClientMessage } from "./rooms";
import type {
  FourReversiMatchDetail,
  FourShogiMatchDetail,
  PublicFourReversiMatchDetail,
  PublicFourShogiMatchDetail,
} from "./matches";
import type { FourShogiAction } from "./fourShogi";
import type { FourReversiRankings, FourShogiRankings } from "./rankings";

type ReversiAction = Extract<
  Extract<RoomSocketClientMessage, { type: "room.game.action" }>["action"],
  { type: "placeStone" }
>;
/** 型だけの対応表。GameId の追加には各ゲームの具体型の登録が必要です。 */
export interface GameTypeMap {
  "four-gomoku": {
    room: FourGomokuRoom;
    match: FourGomokuMatchDetail;
    publicMatch: PublicFourGomokuMatchDetail;
    action: { type: "placeFourGomokuStone"; position: { x: number; y: number } };
    rankings: FourReversiRankings;
  };
  gomoku: {
    room: GomokuRoom;
    match: GomokuMatchDetail;
    publicMatch: PublicGomokuMatchDetail;
    action: { type: "placeGomokuStone"; position: { x: number; y: number } };
    rankings: ReversiRankings;
  };
  shogi: {
    room: ShogiRoom;
    match: ShogiMatchDetail;
    publicMatch: PublicShogiMatchDetail;
    action: ShogiAction;
    rankings: ReversiRankings;
  };
  reversi: {
    room: ReversiRoom;
    match: ReversiMatchDetail;
    publicMatch: PublicReversiMatchDetail;
    action: ReversiAction;
    rankings: ReversiRankings;
  };
  "four-reversi": {
    room: FourReversiRoom;
    match: FourReversiMatchDetail;
    publicMatch: PublicFourReversiMatchDetail;
    action: ReversiAction;
    rankings: FourReversiRankings;
  };
  "four-shogi": {
    room: FourShogiRoom;
    match: FourShogiMatchDetail;
    publicMatch: PublicFourShogiMatchDetail;
    action: FourShogiAction;
    rankings: FourShogiRankings;
  };
}
export type RoomFor<G extends GameId> = GameTypeMap[G]["room"];
export type MatchFor<G extends GameId> = GameTypeMap[G]["match"];
export type PublicMatchFor<G extends GameId> = GameTypeMap[G]["publicMatch"];
export type ReplayMatchFor<G extends GameId> = PublicMatchFor<G> & { selfPlayerId?: string };
export type ActionFor<G extends GameId> = GameTypeMap[G]["action"];
export type RankingsFor<G extends GameId> = GameTypeMap[G]["rankings"];
export type GameActionCommandFor<G extends GameId> = G extends
  | "four-shogi"
  | "shogi"
  | "gomoku"
  | "four-gomoku"
  ? { type: "room.game.action"; action: ActionFor<G>; roundId: string; positionRevision: number }
  : { type: "room.game.action"; action: ActionFor<G>; roundId?: never; positionRevision?: never };
export type GameCommandFor<G extends GameId> =
  | GameActionCommandFor<G>
  | Extract<RoomSocketClientMessage, { type: "room.game.start" | "room.game.resign" }>
  | (G extends "four-shogi" | "shogi"
      ? Extract<RoomSocketClientMessage, { type: "room.game.draw.set" }>
      : never)
  | (G extends "shogi" ? Extract<RoomSocketClientMessage, { type: "room.game.declare" }> : never);
