import { expect, test } from "bun:test";
import { formatStatsRate } from "../src/features/account/statsPresentation";

test("率は先頭0・%なしの小数3桁で表示し、0件は.000にする", () => {
  for (const [count, total, expected] of [
    [0, 0, ".000"],
    [0, 5, ".000"],
    [1, 3, ".333"],
    [1, 2, ".500"],
    [3, 3, "1.000"],
    [3, 2, "1.500"],
    [3, 1, "3.000"],
    [2, 3, ".667"],
    [1, 16, ".063"],
    [1, 17, ".059"],
    [1001, 2000, ".501"],
    [9999, 10000, "1.000"],
  ] as const)
    expect(formatStatsRate(count, total)).toBe(expected);
});
