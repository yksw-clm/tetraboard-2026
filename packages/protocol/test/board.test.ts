import { expect, test } from "bun:test";
import { boardTextLength, boardTextLimit, boardTextSchema } from "../src/board";

test("本文は前後の空白を除き、見た目の文字で1〜1,000字を受け付ける", () => {
  const limitText = "あ".repeat(boardTextLimit - 1) + "👨‍👩‍👧‍👦";
  const withWhitespace = "\n" + limitText + "\n";
  expect(boardTextLength(withWhitespace)).toBe(1000);
  expect(boardTextSchema.parse(withWhitespace)).toBe(limitText);

  const tooLong = limitText + "あ";
  expect(boardTextLength(tooLong)).toBe(1001);
  expect(boardTextSchema.safeParse(tooLong).success).toBe(false);

  const whitespace = " \n　";
  expect(boardTextLength(whitespace)).toBe(0);
  expect(boardTextSchema.safeParse(whitespace).success).toBe(false);
});
