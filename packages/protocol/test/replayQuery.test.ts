import { expect, test } from "bun:test";
import { getFourShogiReplayContract } from "../src/rooms";

test("終局棋譜は通常のページ指定を受け付け、廃止したprefix指定を拒否する", () => {
  const instanceId = crypto.randomUUID();
  expect(getFourShogiReplayContract.query.parse({ instanceId })).toEqual({ instanceId });
  expect(getFourShogiReplayContract.query.parse({ instanceId, cursor: "100" })).toEqual({
    instanceId,
    cursor: 100,
  });
  expect(
    getFourShogiReplayContract.query.safeParse({ instanceId, throughEventCount: "101" }).success,
  ).toBe(false);
  for (const cursor of ["-1", "1.5", "NaN", "10000000000", ""]) {
    expect(getFourShogiReplayContract.query.safeParse({ instanceId, cursor }).success).toBe(false);
  }
});
