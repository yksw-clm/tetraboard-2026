import { expect, test } from "bun:test";
import { formatPlayerStatsSummary } from "../src/features/players/playerStatsSummary";

test("勝敗型は対局数・勝敗分・勝率をまとめ、モードなしでも同じ形式を使う", () => {
  const result = { total: 20, wins: 12, losses: 7, draws: 1 };
  expect(formatPlayerStatsSummary(result, "singles")).toBe("20局 12勝7敗1分 (.600)");
  expect(
    formatPlayerStatsSummary({ singles: { total: 0, first: 0 }, doubles: result }, "doubles"),
  ).toBe("20局 12勝7敗1分 (.600)");
  expect(
    formatPlayerStatsSummary(
      { singles: { total: 0, first: 0 }, doubles: { total: 25, wins: 17, losses: 6, draws: 2 } },
      "doubles",
    ),
  ).toBe("25局 17勝6敗2分 (.680)");
});

test("順位型は優勝率と平均順位を計算し、将棋は累計撃破数を付ける", () => {
  const doubles = { total: 0, wins: 0, losses: 0, draws: 0 };
  expect(
    formatPlayerStatsSummary(
      { singles: { total: 43, first: 3, second: 18, third: 18, fourth: 4 }, doubles },
      "singles",
    ),
  ).toBe("43局 3優勝 (.070) 平均2.53位");
  expect(
    formatPlayerStatsSummary(
      {
        singles: {
          total: 83,
          first: 22,
          second: 36,
          third: 17,
          fourth: 8,
          knockouts: 51,
          perfectWins: 2,
        },
        doubles,
      },
      "singles",
    ),
  ).toBe("83局 22優勝 (.265) 平均2.13位 51撃破");
});

test("0局と旧Workerの不足項目を推測せず表示する", () => {
  const doubles = { total: 0, wins: 0, losses: 0, draws: 0 };
  expect(formatPlayerStatsSummary(doubles, "singles")).toBe("0局 0勝0敗0分 (.000)");
  expect(
    formatPlayerStatsSummary(
      { singles: { total: 0, first: 0, second: 0, third: 0, fourth: 0 }, doubles },
      "singles",
    ),
  ).toBe("0局 0優勝 (.000) 平均—位");
  const legacy = { singles: { total: 43, first: 3 }, doubles: { total: 20, wins: 12 } };
  expect(formatPlayerStatsSummary(legacy, "singles")).toBe("43局 3優勝 (.070)");
  expect(formatPlayerStatsSummary(legacy, "doubles")).toBe("20局 12勝 (.600)");
});
