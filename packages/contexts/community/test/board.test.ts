import { expect, test } from "bun:test";
import { boardPostVisibility, shouldIndexBoardPost } from "../src";

test("投稿の公開状態は削除日時と公開中の返信数で決まる", () => {
  expect(boardPostVisibility(null, 0)).toBe("published");
  expect(boardPostVisibility(null, 1)).toBe("published");
  expect(boardPostVisibility(0, 0)).toBe("notFound");
  expect(boardPostVisibility(0, 1)).toBe("placeholder");
});

const postedAtMs = 1_700_000_000_000;
const after24Hours = postedAtMs + 86_400_000;
const post = { production: true, postedAtMs, deletedAtMs: null, replyCount: 0 };

test("本文50字でも投稿から24時間ちょうどになるまでは index しない", () => {
  const text = "👨‍👩‍👧‍👦".repeat(50);
  expect(shouldIndexBoardPost({ ...post, text, now: after24Hours - 1 })).toBe(false);
  expect(shouldIndexBoardPost({ ...post, text, now: after24Hours })).toBe(true);
  expect(shouldIndexBoardPost({ ...post, text, now: after24Hours + 1 })).toBe(true);
});

test("本文49字では返信が1件以上ある場合だけ index し、削除と非本番は除く", () => {
  const input = { ...post, text: "か\u3099".repeat(49), now: after24Hours };
  expect(shouldIndexBoardPost(input)).toBe(false);
  expect(shouldIndexBoardPost({ ...input, replyCount: 1 })).toBe(true);
  expect(shouldIndexBoardPost({ ...input, replyCount: 1, now: after24Hours - 1 })).toBe(false);
  expect(shouldIndexBoardPost({ ...input, replyCount: 1, deletedAtMs: after24Hours })).toBe(false);
  expect(shouldIndexBoardPost({ ...input, replyCount: 1, production: false })).toBe(false);
});
