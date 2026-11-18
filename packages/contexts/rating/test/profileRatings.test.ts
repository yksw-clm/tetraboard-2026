import { expect, test } from "bun:test";
import { readMatchProfileRating } from "../src";
import { MemoryRatings } from "./memoryPorts";

const match = { game: "four-shogi", matchId: "match", rated: true } as const;
const human = { kind: "human", accountId: "self" } as const;

test("対局前の保存済みレートは後から取得したレートより優先する", async () => {
  const store = new MemoryRatings();
  store.beforeRow = { rating: 25.4, rated_games: 6 };
  const saved = { timing: "before", status: "placement" } as const;
  expect(await readMatchProfileRating(store, { ...match, player: human, saved })).toEqual(saved);
});

test("旧棋譜の本人には保存履歴から対局前のレートを返す", async () => {
  const store = new MemoryRatings();
  store.beforeRow = { rating: 25.4, rated_games: 6 };
  expect(await readMatchProfileRating(store, { ...match, player: human })).toEqual({
    timing: "before",
    status: "rated",
    rating: 1520,
  });
});

test("退会済みの本人の保存レートを返さない", async () => {
  const store = new MemoryRatings();
  store.beforeRow = { rating: 25.4, rated_games: 6 };
  const saved = { timing: "before", status: "rated", rating: 1520 } as const;
  expect(
    await readMatchProfileRating(store, { ...match, player: { ...human, retired: true }, saved }),
  ).toBeUndefined();
});

test.each([
  ["shogi", { rating: 1520 }],
  ["four-shogi", { mu: 25.4 }],
] as const)("%s の CPU に公開用の参照レートを返す", async (game, reference) => {
  const store = new MemoryRatings();
  expect(
    await readMatchProfileRating(store, { ...match, game, player: { kind: "cpu", reference } }),
  ).toEqual({
    timing: "reference",
    status: "rated",
    rating: 1520,
  });
});
