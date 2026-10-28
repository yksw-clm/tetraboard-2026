import { expect, test } from "bun:test";
import { getFourShogiReplayContract } from "../src/rooms";

test("四人将棋のライブ履歴は固定prefixを指定でき、従来の省略形を維持する", () => {
  const instanceId = crypto.randomUUID();
  expect(getFourShogiReplayContract.query.parse({ instanceId })).toEqual({ instanceId });
  expect(
    getFourShogiReplayContract.query.parse({ instanceId, cursor: "100", throughEventCount: "101" }),
  ).toEqual({ instanceId, cursor: 100, throughEventCount: 101 });
  for (const throughEventCount of ["-1", "1.5", "NaN", "10000000000", ""]) {
    expect(
      getFourShogiReplayContract.query.safeParse({ instanceId, throughEventCount }).success,
    ).toBe(false);
  }
});
