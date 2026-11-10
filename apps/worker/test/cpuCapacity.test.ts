import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => {
  for (const game of ["shogi", "four-reversi"])
    await runInDurableObject(env.CPU_CAPACITY.getByName(game), (_, ctx) => ctx.storage.deleteAll());
});

describe("CPU対局枠", () => {
  it("ゲームごとに4局を確保し、同時要求・同じ予約の再送・古い解放を処理する", async () => {
    const shogi = env.CPU_CAPACITY.getByName("shogi");
    const reversi = env.CPU_CAPACITY.getByName("four-reversi");
    const attempts = Array.from({ length: 8 }, (_, i) => String(i).padStart(5, "0"));
    const boards = await Promise.all(attempts.map((id) => shogi.reserve(id, 1, 1)));
    expect(boards.filter(Boolean)).toHaveLength(4);
    expect(await Promise.all(attempts.slice(0, 4).map((id) => reversi.reserve(id, 1, 3)))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    const winner = attempts[boards.indexOf(true)]!;
    const waiting = attempts[boards.indexOf(false)]!;
    expect(await shogi.reserve(winner, 1, 1)).toBe(true);
    expect(await reversi.reserve("99999", 1, 1)).toBe(false);
    expect(await shogi.reserve(waiting, 1, 1)).toBe(false);
    await shogi.release(winner, 1);
    expect(await shogi.reserve(waiting, 1, 1)).toBe(true);
    await shogi.release(winner, 1);
    expect(await shogi.reserve("99999", 1, 1)).toBe(false);
    await shogi.release(waiting, 1);
    expect(await shogi.reserve(winner, 1, 1)).toBe(false);
    expect(await shogi.reserve(winner, 2, 1)).toBe(true);
    await shogi.release(winner, 1);
    expect(await shogi.reserve(winner, 2, 1)).toBe(true);
  });
});
