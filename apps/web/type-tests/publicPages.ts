import type { GameId } from "@tetraboard/protocol/games";
import { publicPages } from "../src/publicPages/catalog";
type Registration = { [G in GameId]: (typeof publicPages)[G] };
// @ts-expect-error 将棋の公開登録欠落を拒否する。
const missing: Registration = { "four-reversi": publicPages["four-reversi"] };
const crossed: Registration = {
  // @ts-expect-error 別ゲームのパスを持つ公開登録を拒否する。
  "four-reversi": publicPages["four-shogi"],
  "four-shogi": publicPages["four-shogi"],
};
void missing;
void crossed;
