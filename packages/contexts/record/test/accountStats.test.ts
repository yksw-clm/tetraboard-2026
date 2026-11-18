import { expect, test } from "bun:test";
import { readAccountStats, readFormationStats, type OutcomeStatsReader } from "../src";
import type { FourShogiFormationStats } from "@tetraboard/protocol";

type RankedRows = Awaited<ReturnType<OutcomeStatsReader["ranked"]>>;
type DuelRow = Awaited<ReturnType<OutcomeStatsReader["duel"]>>;

class MemoryOutcomes implements OutcomeStatsReader {
  rankedRows = new Map<string, RankedRows>();
  duelRows = new Map<string, DuelRow>();

  async ranked(game: string, accountId: string) {
    return this.rankedRows.get(`${game}:${accountId}`) ?? [];
  }

  async duel(game: string, accountId: string) {
    return this.duelRows.get(`${game}:${accountId}`) ?? null;
  }
}

test("順位と勝敗をモード別に返し、四人将棋だけ撃破と完全優勝を含める", async () => {
  const store = new MemoryOutcomes();
  const singles = {
    mode: "singles" as const,
    total: 8,
    first: 3,
    second: 1,
    third: 0,
    fourth: 4,
    wins: 0,
    losses: 0,
    draws: 0,
    knockouts: 9,
    perfectWins: 2,
  };
  const doubles = { ...singles, mode: "doubles" as const, total: 5, wins: 2, losses: 2, draws: 1 };
  for (const game of ["four-shogi", "four-reversi", "four-gomoku"])
    store.rankedRows.set(`${game}:self`, [doubles, singles]);

  const expected = {
    singles: { total: 8, first: 3, second: 1, third: 0, fourth: 4 },
    doubles: { total: 5, wins: 2, losses: 2, draws: 1 },
  };
  expect(await readAccountStats(store, "self", "four-shogi")).toEqual({
    ...expected,
    singles: { ...expected.singles, knockouts: 9, perfectWins: 2 },
  });
  expect(await readAccountStats(store, "self", "four-reversi")).toEqual(expected);
  expect(await readAccountStats(store, "self", "four-gomoku")).toEqual(expected);
});

test("本人の該当履歴がないと四人将棋の両モードをゼロで返す", async () => {
  const store = new MemoryOutcomes();
  expect(await readAccountStats(store, "self", "four-shogi")).toEqual({
    singles: { total: 0, first: 0, second: 0, third: 0, fourth: 0, knockouts: 0, perfectWins: 0 },
    doubles: { total: 0, wins: 0, losses: 0, draws: 0 },
  });
});

test.each(["shogi", "reversi", "gomoku"] as const)(
  "%s は本人の勝敗と引き分けを返す",
  async (game) => {
    const store = new MemoryOutcomes();
    const result = { total: 6, wins: 2, losses: 1, draws: 3 };
    store.duelRows.set(`${game}:self`, result);
    expect(await readAccountStats(store, "self", game)).toEqual(result);
  },
);

test("本人が使った複数の戦法の順位件数を保ち、未使用の戦法を加えない", async () => {
  const formations: FourShogiFormationStats = [
    { id: "tenshukaku", total: 2, first: 2, second: 0, third: 0, fourth: 0 },
    { id: "right-king", total: 3, first: 2, second: 0, third: 1, fourth: 0 },
  ];
  const byAccount = new Map([["self", formations]]);
  const reader = { readFormations: async (id: string) => byAccount.get(id) ?? [] };
  const ids = ["tenshukaku", "right-king", "e-shape"];
  expect(await readFormationStats(reader, "self", ids)).toEqual(formations);
});

test("未知の戦法を含む集計を拒否する", async () => {
  const rows: FourShogiFormationStats = [
    { id: "unknown", total: 1, first: 1, second: 0, third: 0, fourth: 0 },
  ];
  await expect(
    readFormationStats({ readFormations: async () => rows }, "self", ["tenshukaku"]),
  ).rejects.toThrow("Unknown Shogi formation ID");
});
