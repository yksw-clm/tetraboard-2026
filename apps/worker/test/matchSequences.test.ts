import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { reserveMatchSequence } from "../src/rooms/matchSequences";

const scope = () => `tournament:${crypto.randomUUID()}` as const;

test("大会ごとに1から採番し、同時準備も重複せず、完了・取消に関係なく再利用しない", async () => {
  const first = scope(),
    second = scope();
  const matchId = crypto.randomUUID();
  expect(await reserveMatchSequence(env.APP_DB, matchId, first)).toBe(1);
  const numbers = await Promise.all(
    Array.from({ length: 12 }, () => reserveMatchSequence(env.APP_DB, crypto.randomUUID(), first)),
  );
  expect(numbers.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 2));
  expect(await reserveMatchSequence(env.APP_DB, matchId, first)).toBe(1);
  expect(await reserveMatchSequence(env.APP_DB, crypto.randomUUID(), first)).toBe(14);
  expect(await reserveMatchSequence(env.APP_DB, crypto.randomUUID(), second)).toBe(1);
});

test("同じ対局の同時再送は一つの番号に収束し、別範囲への転用を拒否する", async () => {
  const matchId = crypto.randomUUID(),
    range = scope();
  expect(
    await Promise.all(
      Array.from({ length: 8 }, () => reserveMatchSequence(env.APP_DB, matchId, range)),
    ),
  ).toEqual(Array(8).fill(1));
  await expect(reserveMatchSequence(env.APP_DB, matchId, scope())).rejects.toThrow(
    "Invalid match sequence",
  );
  expect(await reserveMatchSequence(env.APP_DB, crypto.randomUUID(), range)).toBe(2);
});

test("4ゲームのレート戦は別々に継続し、同じ対局の再送でカウンターを進めない", async () => {
  for (const game of ["four-shogi", "four-reversi", "shogi", "reversi"] as const) {
    const range = `rated:${game}` as const;
    const previous = await env.APP_DB.prepare(
      "SELECT COALESCE(MAX(sequence),0) AS n FROM room_match_sequences WHERE scope=?",
    )
      .bind(range)
      .first<{ n: number }>();
    const id = crypto.randomUUID();
    expect(await reserveMatchSequence(env.APP_DB, id, range)).toBe(previous!.n + 1);
    expect(await reserveMatchSequence(env.APP_DB, id, range)).toBe(previous!.n + 1);
  }
});
