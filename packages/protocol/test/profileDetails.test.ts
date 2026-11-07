import { expect, test } from "bun:test";
import { accountProfileSchema, favoriteGamesSchema, profileMessageSchema } from "../src";

test("ひとことは前後空白を除去し、30書記素を許可して改行を拒否する", () => {
  expect(profileMessageSchema.parse(" \t ")).toBe("");
  expect(profileMessageSchema.parse(` ${"👨‍👩‍👧‍👦".repeat(30)} `)).toBe("👨‍👩‍👧‍👦".repeat(30));
  expect(profileMessageSchema.safeParse("あ".repeat(31)).success).toBe(false);
  for (const newline of ["\r", "\n", "\u2028", "\u2029"])
    expect(profileMessageSchema.safeParse(`ひとこと${newline}`).success).toBe(false);
});

test("お気に入りは0〜3つの重複しないゲームを共通順序で返し、追加前の本人応答も受理する", () => {
  expect(favoriteGamesSchema.parse([])).toEqual([]);
  expect(favoriteGamesSchema.parse(["gomoku", "shogi", "four-reversi"])).toEqual([
    "four-reversi",
    "shogi",
    "gomoku",
  ]);
  for (const value of [
    ["unknown"],
    ["shogi", "shogi"],
    ["shogi", "reversi", "gomoku", "four-shogi"],
  ])
    expect(favoriteGamesSchema.safeParse(value).success).toBe(false);
  expect(
    accountProfileSchema.safeParse({
      name: "名前",
      username: "name_id",
      avatarUrl: null,
      profileCompleted: true,
    }).success,
  ).toBe(true);
});
