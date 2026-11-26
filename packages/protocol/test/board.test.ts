import { expect, test } from "bun:test";
import {
  boardPostInputSchema,
  boardTextLength,
  boardTextLimit,
  boardTextSchema,
} from "../src/board";

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

test("添付は公開棋譜の ID と 0 以上の安全な整数で指定する", () => {
  const input = { requestId: crypto.randomUUID(), text: "本文" };
  const matchId = crypto.randomUUID();
  expect(boardPostInputSchema.safeParse(input).success).toBe(true);
  expect(boardPostInputSchema.parse({ ...input, attachment: { matchId, position: 0 } })).toEqual({
    ...input,
    attachment: { matchId, position: 0 },
  });
  for (const position of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0"])
    expect(
      boardPostInputSchema.safeParse({ ...input, attachment: { matchId, position } }).success,
    ).toBe(false);
  expect(
    boardPostInputSchema.safeParse({ ...input, attachment: { matchId: "abc", position: 0 } })
      .success,
  ).toBe(false);
});
