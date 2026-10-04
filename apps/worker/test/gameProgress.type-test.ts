import type { GameId, GameActionCommandFor, RoomFor } from "@tetraboard/protocol";
import {
  gameProgress,
  type FinishedProgress,
  type RematchFor,
  type ProgressFor,
} from "../src/rooms/gameProgress";
// @ts-expect-error 各GameIdの進行登録が必須
export const missingRegistration: Record<GameId | "unregistered-game", unknown> = gameProgress;
// @ts-expect-error 別ゲームのfactoryを登録できない
export const wrongRegistration: (typeof gameProgress)["four-shogi"] = gameProgress["four-reversi"];
declare const reversi: Extract<RoomFor<"four-reversi">, { status: "playing" }>;
declare const shogi: Extract<RoomFor<"four-shogi">, { status: "playing" }>;
declare const reversiFinished: FinishedProgress<"four-reversi">;
declare const shogiFinished: FinishedProgress<"four-shogi">;
declare const reversiRematch: RematchFor<"four-reversi">;
declare const shogiRematch: RematchFor<"four-shogi">;
declare const dependencies: import("../src/rooms/gameProgress").ProgressDependencies;
const r = gameProgress["four-reversi"].create(dependencies);
const s = gameProgress["four-shogi"].create(dependencies);
declare const move: GameActionCommandFor<"four-shogi">;
// @ts-expect-error リバーシ進行へ将棋Roomを渡せない
r.resign(shogi, "hash");
// @ts-expect-error 将棋進行へリバーシRoomを渡せない
s.resign(reversi, "hash");
// @ts-expect-error リバーシ進行へ将棋着手を渡せない
r.play(reversi, "hash", move);
// @ts-expect-error 将棋の着手に局IDが必須
export const missingRound: GameActionCommandFor<"four-shogi"> = {
  type: "room.game.action",
  action: move.action,
  positionRevision: 0,
};
// @ts-expect-error 将棋の着手にrevisionが必須
export const missingRevision: GameActionCommandFor<"four-shogi"> = {
  type: "room.game.action",
  action: move.action,
  roundId: "round",
};
s.play(shogi, "hash", {
  type: "room.game.action",
  // @ts-expect-error 将棋進行へリバーシ着手を渡せない
  action: { type: "placeStone", position: { x: 0, y: 0 } },
  roundId: "round",
  positionRevision: 0,
});
// @ts-expect-error リバーシ終局結果を将棋へ流入させない
s.finalize(reversiFinished);
// @ts-expect-error 将棋終局結果をリバーシへ流入させない
r.finalize(shogiFinished);
export const wrongFinishedRoom: FinishedProgress<"four-shogi"> = {
  ...shogiFinished,
  // @ts-expect-error 終局Roomとゲーム局面を取り違えられない
  room: reversi,
};
export const wrongFinishedGame: FinishedProgress<"four-reversi"> = {
  ...reversiFinished,
  // @ts-expect-error 終局局面のゲームを取り違えられない
  game: shogiFinished.game,
};
// @ts-expect-error リバーシの再戦データを将棋へ渡せない
s.waiting(reversiRematch, shogi.players);
// @ts-expect-error 将棋の再戦データをリバーシへ渡せない
r.waiting(shogiRematch, reversi.players);
// @ts-expect-error 再戦データと配席のゲームを取り違えられない
s.waiting(shogiRematch, reversi.players);
export const wrongLastRound: RematchFor<"four-shogi"> = {
  ...shogiRematch,
  // @ts-expect-error 再戦Roomと直前局の型を取り違えられない
  lastRound: reversiRematch.lastRound,
};
export const wrongProgress: ProgressFor<"four-reversi"> = {
  kind: "playing",
  gameId: "four-reversi",
  // @ts-expect-error 継続結果のゲームとRoomを取り違えられない
  room: shogi,
};

// @ts-expect-error 既存ゲームの登録を省略できない
export const omittedShogi: import("../src/rooms/gameProgress").GameProgressRegistration = {
  "four-reversi": gameProgress["four-reversi"],
};
declare const waiting: Extract<RoomFor<"four-reversi">, { status: "waiting" }>;
export const wrongPlayingStatus: ProgressFor<"four-reversi"> = {
  kind: "playing",
  gameId: "four-reversi",
  // @ts-expect-error 継続結果に待機Roomを混ぜられない
  room: waiting,
};
