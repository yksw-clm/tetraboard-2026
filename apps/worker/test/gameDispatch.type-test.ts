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

import { createClock, advanceClock } from "../src/rooms/clock";
import { createShogiClock, advanceShogiClock } from "../src/rooms/shogiClock";
import type { PlayingRoomClock, PlayingShogiClock } from "@tetraboard/protocol";
const reversiClock = createClock(0);
const shogiClock = createShogiClock(0);
// @ts-expect-error リバーシ時計に将棋のSideを渡せない
advanceClock(reversiClock, "south", "west", 1, true);
// @ts-expect-error 将棋時計にリバーシのColorを渡せない
advanceShogiClock(shogiClock, "black", "white", 1, true);
// @ts-expect-error 将棋の残時間recordをリバーシ時計に流入させない
export const wrongReversiClock: PlayingRoomClock = shogiClock;
// @ts-expect-error リバーシの残時間recordを将棋時計に流入させない
export const wrongShogiClock: PlayingShogiClock = reversiClock;
// @ts-expect-error リバーシの4色すべての残時間が必須
export const missingColor: PlayingRoomClock["remainingMainMs"] = { black: 0, white: 0, red: 0 };
// @ts-expect-error 将棋の4方向すべての残時間が必須
export const missingSide: PlayingShogiClock["remainingMainMs"] = { south: 0, west: 0, north: 0 };
// @ts-expect-error リバーシ時計を将棋の更新関数に渡せない
advanceShogiClock(reversiClock, "south", "west", 1, true);
// @ts-expect-error 将棋時計をリバーシの更新関数に渡せない
advanceClock(shogiClock, "black", "white", 1, true);
