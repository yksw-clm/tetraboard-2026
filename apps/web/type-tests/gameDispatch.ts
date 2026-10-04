import type { useRoomSession } from "../src/features/room/useRoomSession";
import type { useFourShogiRoomSession } from "../src/features/room/useFourShogiRoomSession";
import { lobbyRoutes } from "../src/app/router";
import type {
  ActionFor,
  FourReversiRoom,
  FourShogiRoom,
  FourReversiMatchDetail,
  FourShogiMatchDetail,
  GameActionCommandFor,
  GameId,
  MatchFor,
  RoomFor,
} from "@tetraboard/protocol";
import { gameRankingContracts, type GameRankingContracts } from "@tetraboard/protocol";
import { liveViews, type LivePropsFor } from "../src/features/room/liveViews";
import { replayLoaders } from "../src/features/room/matchReplayLoader";
import type { MatchReplayDataFor } from "../src/features/room/matchReplayLoader";
import { replayViews } from "../src/features/room/replayViews";
import {
  createRoomRequests,
  type CreateRoomRequests,
} from "../src/features/lobby/createRoomRequests";
import type { ComponentType } from "react";

declare const shogiRoom: RoomFor<"four-shogi">;
declare const reversiMatch: MatchFor<"four-reversi">;
declare const shogiMatch: MatchFor<"four-shogi">;
declare const shogiAction: ActionFor<"four-shogi">;
declare const reversiAction: ActionFor<"four-reversi">;
// @ts-expect-error 別ゲームのRoomはライブ画面へ渡せない
export const wrongRoom: RoomFor<"four-reversi"> = shogiRoom;
// @ts-expect-error 別ゲームのMatchは棋譜へ渡せない
export const wrongMatch: MatchFor<"four-reversi"> = shogiMatch;
// @ts-expect-error 移動・駒打ちは石置きではない
export const wrongAction: ActionFor<"four-reversi"> = shogiAction;
// @ts-expect-error 石置きは将棋の着手ではない
export const wrongShogiAction: ActionFor<"four-shogi"> = reversiAction;
// @ts-expect-error 将棋の送信には局IDとrevisionが必須
export const missingPosition: GameActionCommandFor<"four-shogi"> = {
  type: "room.game.action",
  action: shogiAction,
};
export const unexpectedPosition: GameActionCommandFor<"four-reversi"> = {
  type: "room.game.action",
  action: reversiAction,
  // @ts-expect-error リバーシの着手に局IDは混ぜられない
  roundId: "id",
  // @ts-expect-error リバーシの着手にrevisionは混ぜられない
  positionRevision: 0,
};
// @ts-expect-error 将棋の棋譜フレームは必須
export const missingFrames: MatchReplayDataFor<"four-shogi"> = {
  game: "four-shogi",
  match: shogiMatch,
};
export const wrongReplay: MatchReplayDataFor<"four-shogi"> = {
  game: "four-shogi",
  // @ts-expect-error ゲーム判別子とMatchは一致する必要がある
  match: reversiMatch,
  frames: [],
};
// @ts-expect-error 作成のゲーム登録は省略できない
export const missingCreation: CreateRoomRequests = {
  "four-reversi": createRoomRequests["four-reversi"],
};
// @ts-expect-error ランキングのパスはゲームに対応する必要がある
export const wrongRankings: GameRankingContracts["four-shogi"] =
  gameRankingContracts["four-reversi"];
// @ts-expect-error ライブ画面を取り違えられない
export const wrongLiveView: ComponentType<LivePropsFor<"four-shogi">> = liveViews["four-reversi"];
// @ts-expect-error 棋譜の前処理を取り違えられない
export const wrongReplayLoader: (typeof replayLoaders)["four-shogi"] =
  replayLoaders["four-reversi"];
// @ts-expect-error 棋譜画面を取り違えられない
export const wrongReplayView: (typeof replayViews)["four-shogi"] = replayViews["four-reversi"];
type ExtendedGameId = GameId | "unregistered-game";
// @ts-expect-error 新IDのランキング登録漏れを検出
export const incompleteRankings: Record<ExtendedGameId, unknown> = gameRankingContracts;
// @ts-expect-error 新IDのライブ登録漏れを検出
export const incompleteLive: Record<ExtendedGameId, unknown> = liveViews;
// @ts-expect-error 新IDの棋譜前処理登録漏れを検出
export const incompleteReplayLoaders: Record<ExtendedGameId, unknown> = replayLoaders;
// @ts-expect-error 新IDの棋譜画面登録漏れを検出
export const incompleteReplayViews: Record<ExtendedGameId, unknown> = replayViews;
// @ts-expect-error 新IDのロビー登録漏れを検出
export const incompleteLobby: Record<ExtendedGameId, unknown> = lobbyRoutes;

// 正の代入も検証し、対応表自体の入れ替わりを検出する。
declare const reversiRoom: FourReversiRoom;
declare const expectedShogiRoom: FourShogiRoom;
declare const expectedReversiMatch: FourReversiMatchDetail;
declare const expectedShogiMatch: FourShogiMatchDetail;
export const validReversiRoom: RoomFor<"four-reversi"> = reversiRoom;
export const validShogiRoom: RoomFor<"four-shogi"> = expectedShogiRoom;
export const validReversiMatch: MatchFor<"four-reversi"> = expectedReversiMatch;
export const validShogiMatch: MatchFor<"four-shogi"> = expectedShogiMatch;

type ShogiSend = Parameters<ReturnType<typeof useFourShogiRoomSession>["sendGameMessage"]>[0];
type ReversiSend = Parameters<ReturnType<typeof useRoomSession>["sendGameMessage"]>[0];
// @ts-expect-error 実際の将棋送信境界でも局面情報を省略できない
export const invalidShogiSend: ShogiSend = { type: "room.game.action", action: shogiAction };
// @ts-expect-error 実際のリバーシ送信境界へ将棋の着手を渡せない
export const invalidReversiSend: ReversiSend = { type: "room.game.action", action: shogiAction };
// @ts-expect-error 新IDの作成登録漏れを検出
export const incompleteCreation: Record<ExtendedGameId, unknown> = createRoomRequests;
