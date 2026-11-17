import { expect, test } from "bun:test";
import { applySkillRating, prepareSkillRating, type SkillMatch } from "../src";
import { MemoryRatings, skillMatch, seed } from "./memoryPorts";

test("skill の書き込みは準備中には反映せず、保存後の再送は一度だけ反映する", async () => {
  const store = new MemoryRatings();
  seed(store);
  const match = skillMatch();
  const prepared = await prepareSkillRating(store, "four-reversi", match);
  expect(store.saved.size).toBe(0);
  expect(store.accounts.get("a")?.rated_games).toBe(0);
  expect(prepared?.count).toBe(1);
  await store.save(prepared!.write);
  const saved = structuredClone(store.saved);
  await applySkillRating(store, "four-reversi", match);
  expect(store.saved).toEqual(saved);
  expect(store.saves).toBe(1);
  expect(store.saved.get("four-reversi:match")).toEqual([
    {
      accountId: "a",
      muBefore: 25,
      sigmaBefore: 25 / 3,
      muAfter: 29.37245650084074,
      sigmaAfter: 8.061839175731805,
      ratedGames: 1,
      humanGames: 0,
    },
  ]);
});

test.each([1, 2, 4])("人間 %i 人の全員を更新し、CPU を保存しない", async (humans) => {
  const store = new MemoryRatings();
  seed(store, humans);
  await applySkillRating(store, "four-shogi", skillMatch(humans));
  const changes = store.saved.get("four-shogi:match")!;
  expect(changes).toHaveLength(humans);
  expect(changes.every((c) => c.ratedGames === 1 && c.humanGames === Number(humans > 1))).toBe(
    true,
  );
});

test.each([
  { humans: 2, cap: 24 },
  { humans: 4, cap: 32 },
])("配置戦の最終局と認定後の上限 $cap", async ({ humans, cap }) => {
  for (const games of [4, 5]) {
    const store = new MemoryRatings();
    seed(store, humans, games);
    await applySkillRating(store, "four-reversi", skillMatch(humans));
    const changes = store.saved.get("four-reversi:match")!;
    expect(changes[0]!.ratedGames).toBe(games + 1);
    const delta = Math.round(1500 + 50 * (changes[0]!.muAfter - 25)) - 1500;
    expect(games === 4 ? delta > cap : delta === cap).toBe(true);
    expect(changes.every((c) => c.sigmaAfter !== c.sigmaBefore)).toBe(true);
  }
});

test("競合した更新を読み直し、3 回の競合で再送を要求する", async () => {
  const store = new MemoryRatings();
  seed(store);
  store.conflicts = 2;
  await applySkillRating(store, "four-reversi", skillMatch());
  expect(store.saves).toBe(3);
  expect(store.accounts.get("a")?.rated_games).toBe(1);
  const failed = new MemoryRatings();
  seed(failed);
  failed.conflicts = 3;
  await expect(applySkillRating(failed, "four-reversi", skillMatch())).rejects.toThrow("再試行");
  expect(failed.saved.size).toBe(0);
});

test("同じ前の推定を読んだ別の対局を再計算し、更新を失わない", async () => {
  const store = new MemoryRatings();
  seed(store);
  const first = await prepareSkillRating(store, "four-shogi", skillMatch());
  const secondMatch = { ...skillMatch(), id: "next" };
  const stale = await prepareSkillRating(store, "four-shogi", secondMatch);
  await store.save(first!.write);
  expect(await store.save(stale!.write)).toBe(0);
  await applySkillRating(store, "four-shogi", secondMatch);
  expect(store.saved.get("four-shogi:next")?.[0]).toMatchObject({
    muBefore: store.saved.get("four-shogi:match")![0]!.muAfter,
    ratedGames: 2,
  });
});

const excluded: [string, (match: SkillMatch) => void][] = [
  [
    "通常戦",
    (m) => {
      delete m.source;
    },
  ],
  [
    "代替手",
    (m) => {
      m.source!.usedFallback = true;
    },
  ],
  [
    "結果がダブルス",
    (m) => {
      m.result.mode = "doubles";
    },
  ],
  [
    "設定がダブルス",
    (m) => {
      m.settings.mode = "doubles";
    },
  ],
  [
    "時計",
    (m) => {
      m.settings.timeControl = { mainTimeMs: 1, byoyomiMs: 1 };
    },
  ],
  [
    "席数",
    (m) => {
      m.participants.pop();
    },
  ],
  [
    "重複席",
    (m) => {
      m.participants[1]!.seat = "a";
    },
  ],
  [
    "順位欠落",
    (m) => {
      m.result.standings.pop();
    },
  ],
  [
    "アカウント欠落",
    (m) => {
      m.participants[0]!.accountId = null;
    },
  ],
  [
    "アカウント重複",
    (m) => {
      m.participants[1] = { kind: "human", accountId: "a", seat: "b" };
      delete m.source!.cpu.b;
    },
  ],
  [
    "CPU参照の余分な席",
    (m) => {
      m.source!.cpu.extra = m.source!.cpu.b;
    },
  ],
  [
    "CPU参照欠落",
    (m) => {
      delete m.source!.cpu.b;
    },
  ],
];
test.each(excluded)("対象外の %s では書き込まない", async (_label, change) => {
  for (const game of ["four-shogi", "four-reversi"] as const) {
    const store = new MemoryRatings();
    seed(store);
    const match = skillMatch();
    change(match);
    await applySkillRating(store, game, match);
    expect(store.saved.size).toBe(0);
    expect(store.saves).toBe(0);
  }
});
test("全員が登録済みでなければ更新せず、CPU だけの対局も対象外", async () => {
  const store = new MemoryRatings();
  seed(store);
  await applySkillRating(store, "four-shogi", skillMatch(2));
  await applySkillRating(store, "four-reversi", skillMatch(0));
  expect(store.saves).toBe(0);
});
test("四人リバーシのプロフィール照合と四人将棋の三人攻め禁止を保つ", async () => {
  const store = new MemoryRatings();
  seed(store);
  for (const field of ["id", "hash"] as const) {
    const match = skillMatch();
    match.participants[1]!.cpuProfile![field] = "different";
    await applySkillRating(store, "four-reversi", match);
  }
  const match = skillMatch();
  delete match.settings.threePlayerAttackProhibited;
  await applySkillRating(store, "four-shogi", match);
  expect(store.saves).toBe(0);
});
