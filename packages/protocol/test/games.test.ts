import { expect, test } from "bun:test";
import { gameIds, gameNameWithAlias } from "../src/games";

test("全ゲームの表示名を返し、リバーシと四人リバーシには別名を添える", () => {
  expect(Object.fromEntries(gameIds.map((game) => [game, gameNameWithAlias(game)]))).toEqual({
    "four-reversi": "四人リバーシ（オセロ）",
    "four-shogi": "四人将棋",
    reversi: "リバーシ（オセロ）",
    shogi: "将棋",
    gomoku: "五目並べ",
    "four-gomoku": "四人五目並べ",
  });
});
