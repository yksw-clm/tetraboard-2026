import type { GameId, RoomFor } from "@tetraboard/protocol";
import { waitingRoomFactories, type WaitingRoomFactories } from "../src/rooms/waitingRoomFactories";
import { rankingReaders } from "../src/rooms/rankingRoutes";
// @ts-expect-error 初期Roomのゲームを取り違えられない
export const wrongFactory: WaitingRoomFactories["four-shogi"] =
  waitingRoomFactories["four-reversi"];
// @ts-expect-error ゲーム追加時に初期Room登録が必須
export const missingFactory: Record<GameId | "unregistered-game", unknown> = waitingRoomFactories;
// @ts-expect-error ゲーム追加時にランキング取得登録が必須
export const missingReader: Record<GameId | "unregistered-game", unknown> = rankingReaders;
declare const playing: Extract<RoomFor<"four-reversi">, { status: "playing" }>;
// @ts-expect-error factoryは待機Roomを返す
export const wrongStatus: ReturnType<WaitingRoomFactories["four-reversi"]> = playing;
