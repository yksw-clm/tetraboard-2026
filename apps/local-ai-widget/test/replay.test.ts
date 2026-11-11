import { expect, test } from "bun:test";
import { ShogiReplayCache } from "../src/replay";
import { shogiObservation, progressFor, settle } from "./fixtures";
import { WidgetController } from "../src/controller";
import type { ContinuousRequest } from "../src/model";
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

test("既定の棋譜取得はブラウザのfetchをGlobalオブジェクトの文脈で呼び出す", async () => {
  const original = globalThis.fetch;
  const observation = shogiObservation();
  const receivers: unknown[] = [];
  globalThis.fetch = Object.assign(
    function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
      receivers.push(this);
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        Response.json({
          instanceId: observation.instanceId,
          roundId: observation.roundId,
          rulesVersion: 1,
          positionRevision: observation.positionRevision,
          initial: { mode: "singles", threePlayerAttackProhibited: true },
          eventCount: 0,
          events: [],
          nextCursor: null,
        }),
      );
    },
    { preconnect: original.preconnect },
  );
  try {
    const cache = new ShogiReplayCache();
    expect(await cache.load(observation, new AbortController().signal)).toEqual([]);
    expect(receivers).toEqual([globalThis]);
    let request: ContinuousRequest | null = null;
    const controller = new WidgetController(
      async (message) => {
        const m = message as { type: string; request: ContinuousRequest };
        if (m.type === "start") {
          request = m.request;
          const initial = progressFor(request, 0);
          initial.candidates = [];
          return { ok: true, data: initial };
        }
        if (m.type === "poll" && request) return { ok: true, data: progressFor(request) };
        return { ok: true };
      },
      () => {},
      "https://tetraboard.net/rooms/12345",
      async () => "a".repeat(64),
      undefined,
      () => () => {},
    );
    try {
      controller.observe(observation);
      await controller.toggle();
      await settle();
      expect(controller.error).toBe("");
      expect(controller.result?.game).toBe("four-shogi");
      expect(controller.result?.sequence).toBe(1);
      expect(controller.busy).toBe(true);
      expect(receivers).toEqual([globalThis, globalThis]);
    } finally {
      controller.stop();
    }
  } finally {
    globalThis.fetch = original;
  }
});
