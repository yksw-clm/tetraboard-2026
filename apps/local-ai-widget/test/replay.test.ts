import { expect, test } from "bun:test";
import { ShogiReplayCache } from "../src/replay";
import { shogiObservation } from "./fixtures";
import type { FourShogiReplayEvent } from "@tetraboard/protocol";
const event = (i: number): FourShogiReplayEvent => ({
  type: "drawProposal",
  side: "south",
  proposed: i % 2 === 0,
});
test("将棋の履歴は100件ずつ取得し、次のrevisionでは末尾だけ取得する", async () => {
  const observation = shogiObservation(),
    cursors: number[] = [];
  let count = 101;
  const cache = new ShogiReplayCache((async (path) => {
    const cursor = Number(
      new URL(String(path), "https://tetraboard.net").searchParams.get("cursor"),
    );
    cursors.push(cursor);
    const end = Math.min(cursor + 100, count);
    return Response.json({
      instanceId: observation.instanceId,
      roundId: observation.roundId,
      rulesVersion: 1,
      positionRevision: observation.positionRevision,
      initial: { mode: "singles", threePlayerAttackProhibited: true },
      eventCount: count,
      events: Array.from({ length: end - cursor }, (_, i) => ({
        index: cursor + i,
        event: event(cursor + i),
      })),
      nextCursor: end < count ? end : null,
    });
  }) as typeof fetch);
  const signal = new AbortController().signal;
  expect(await cache.load(observation, signal)).toHaveLength(101);
  count = 102;
  observation.positionRevision++;
  expect(await cache.load(observation, signal)).toHaveLength(102);
  expect(cursors).toEqual([0, 100, 101]);
  observation.roundId = crypto.randomUUID();
  await cache.load(observation, signal);
  expect(cursors.slice(-2)).toEqual([0, 100]);
});
test("棋譜の欠落・revision競合・中断では部分取得をキャッシュしない", async () => {
  for (const failure of ["gap", "revision", "conflict", "abort"]) {
    const observation = shogiObservation(),
      controller = new AbortController(),
      cursors: number[] = [];
    let failing = true;
    const cache = new ShogiReplayCache((async (path) => {
      const cursor = Number(
        new URL(String(path), "https://tetraboard.net").searchParams.get("cursor"),
      );
      cursors.push(cursor);
      if (failing && failure === "conflict") return Response.json({}, { status: 409 });
      if (failing && failure === "abort") controller.abort();
      return Response.json({
        instanceId: observation.instanceId,
        roundId: observation.roundId,
        rulesVersion: 1,
        positionRevision:
          observation.positionRevision + (failing && failure === "revision" ? 1 : 0),
        initial: { mode: "singles", threePlayerAttackProhibited: true },
        eventCount: 1,
        events: [{ index: failing && failure === "gap" ? 1 : 0, event: event(0) }],
        nextCursor: null,
      });
    }) as typeof fetch);
    await expect(cache.load(observation, controller.signal)).rejects.toThrow();
    failing = false;
    expect(await cache.load(observation, new AbortController().signal)).toHaveLength(1);
    expect(cursors).toEqual([0, 0]);
  }
});
