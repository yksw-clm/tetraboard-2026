import { reversiActionComplete } from "../src/features/room/fourReversiSessionBehavior";
import { shogiActionComplete } from "../src/features/room/fourShogiSessionBehavior";
import type { PendingShogiAction } from "../src/features/room/fourShogiSessionBehavior";
import type { PendingReversiAction } from "../src/features/room/fourReversiSessionBehavior";
import type { RoomTransportOptions } from "../src/features/room/useRoomTransport";
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

// sessionの待機データと判定も具体的なゲームへ結び付ける。
declare const reversiPending: PendingReversiAction;
declare const shogiPending: PendingShogiAction;
// @ts-expect-error 別ゲームのRoomで完了判定できない
reversiActionComplete(shogiRoom, reversiPending);
// @ts-expect-error 別ゲームの待機データで完了判定できない
shogiActionComplete(shogiRoom, reversiPending);
// @ts-expect-error リバーシへ将棋の待機データを渡せない
reversiActionComplete(reversiRoom, shogiPending);
// @ts-expect-error 将棋の着手待ちには局IDが必須
export const missingPendingRound: PendingShogiAction = { type: "move", positionRevision: 0 };
// @ts-expect-error 将棋の着手待ちにはrevisionが必須
export const missingPendingRevision: PendingShogiAction = { type: "move", roundId: "id" };
// @ts-expect-error 将棋の提案待ちにも局面情報が必須
export const missingDrawPosition: PendingShogiAction = {
  type: "draw",
  participant: "south",
  proposed: true,
};
// @ts-expect-error transportの判定関数とRoomは同じゲームでなければならない
export const wrongCompletion: RoomTransportOptions<FourShogiRoom>["actionComplete"] =
  reversiActionComplete;
type ReversiSettingsSend = Parameters<
  ReturnType<typeof useRoomSession>["sendGameSettingsMessage"]
>[0];
type ShogiSettingsSend = Parameters<
  ReturnType<typeof useFourShogiRoomSession>["sendGameSettingsMessage"]
>[0];
// @ts-expect-error リバーシから将棋固有設定を送信できない
export const invalidReversiSettings: ReversiSettingsSend = {
  type: "room.three-player-attack.set",
  prohibited: false,
};
export const validShogiSettings: ShogiSettingsSend = {
  type: "room.three-player-attack.set",
  prohibited: false,
};
type ShogiPendingSend = Parameters<
  ReturnType<typeof useFourShogiRoomSession>["sendGameMessage"]
>[1];
// @ts-expect-error 実際の送信境界でも将棋の局面情報を省略できない
export const invalidPendingSend: ShogiPendingSend = { type: "move" };

// @ts-expect-error 開始は共有入口が管理し、ゲーム固有の送信待ちと混ぜられない
export const invalidStartSend: ShogiSend = { type: "room.game.start" };

declare const gomokuAction: ActionFor<"gomoku">;
declare const gomokuRoom: RoomFor<"gomoku">;
// @ts-expect-error 五目並べの着手も局IDと更新番号が必須
export const missingGomokuPosition: GameActionCommandFor<"gomoku"> = {
  type: "room.game.action",
  action: gomokuAction,
};
// @ts-expect-error 15路の着手を既存のリバーシ通信に流入させない
export const wrongGomokuAction: ActionFor<"reversi"> = gomokuAction;
// @ts-expect-error 五目並べのルームを通常リバーシとして扱わない
export const wrongGomokuRoom: RoomFor<"reversi"> = gomokuRoom;
