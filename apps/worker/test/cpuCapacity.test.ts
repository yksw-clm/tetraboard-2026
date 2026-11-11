import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

afterEach(async () => {
  for (const game of ["shogi", "reversi", "four-reversi", "four-shogi"])
    await runInDurableObject(env.CPU_CAPACITY.getByName(game), (_, ctx) => ctx.storage.deleteAll());
});

describe("CPU対局枠", () => {
  it.each([
    { game: "four-shogi", maximum: 12, step: 3 },
    { game: "four-reversi", maximum: 12, step: 3 },
    { game: "shogi", maximum: 4, step: 1 },
    { game: "reversi", maximum: 4, step: 1 },
  ])(
    "$gameの空き枠は予約・再送・古い解放を区別し、照会では状態を変えない",
    async ({ game, maximum, step }) => {
      const capacity = env.CPU_CAPACITY.getByName(game);
      const before = await runInDurableObject(capacity, (_, ctx) => [...ctx.storage.kv.list()]);
      expect(await capacity.availableSeats()).toBe(maximum);
      expect(await runInDurableObject(capacity, (_, ctx) => [...ctx.storage.kv.list()])).toEqual(
        before,
      );
      for (let i = 0; i < 4; i++) {
        expect(await capacity.reserve(String(i), 2, 1)).toBe(true);
        expect(await capacity.reserve(String(i), 2, 1)).toBe(true);
        expect(await capacity.availableSeats()).toBe(maximum - (i + 1) * step);
      }
      await capacity.release("0", 1);
      expect(await capacity.availableSeats()).toBe(0);
      await capacity.release("0", 2);
      expect(await capacity.availableSeats()).toBe(step);
      await capacity.release("0", 2);
      expect(await capacity.availableSeats()).toBe(step);
      expect(await capacity.reserve("0", 1, 1)).toBe(false);
      expect(await capacity.availableSeats()).toBe(step);
    },
  );
  it("四人リバーシが満枠でも四人将棋は独立して4局を確保できる", async () => {
    const reversi = env.CPU_CAPACITY.getByName("four-reversi");
    const shogi = env.CPU_CAPACITY.getByName("four-shogi");
    for (const roomId of ["00001", "00002", "00003", "00004"])
      expect(await reversi.reserve(roomId, 1, 3)).toBe(true);
    expect(await reversi.availableSeats()).toBe(0);
    expect(await shogi.availableSeats()).toBe(12);
    expect(await reversi.reserve("00005", 1, 3)).toBe(false);
    for (const roomId of ["00005", "00006", "00007", "00008"])
      expect(await shogi.reserve(roomId, 1, 3)).toBe(true);
    expect(await shogi.reserve("00009", 1, 3)).toBe(false);
  });

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
