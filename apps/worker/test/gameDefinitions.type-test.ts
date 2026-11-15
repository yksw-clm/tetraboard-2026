import type { GameId } from "@tetraboard/protocol";
import { gameDefinitions, type GameDefinitions } from "../src/rooms/gameDefinitions";

declare const missingOne: {
  [G in GameId]: Omit<typeof gameDefinitions, G>;
}[GameId];
// @ts-expect-error 6ゲームのどれが欠けても登録表として受け付けません。
export const incompleteDefinitions: GameDefinitions = missingOne;
// @ts-expect-error ゲームIDと定義の対応を取り違えられません。
export const wrongDefinition: GameDefinitions["four-shogi"] = gameDefinitions.shogi;
export const completeDefinitions: GameDefinitions = gameDefinitions;
