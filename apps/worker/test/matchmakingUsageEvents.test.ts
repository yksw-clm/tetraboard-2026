import { GameRoom } from "../src/durableObjects/gameRoom/gameRoom";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { matchmakingQueues } from "@tetraboard/protocol";
import { CpuCapacity } from "../src/durableObjects/cpuCapacity";
import { recordUsageEvents } from "./usageEventsRecorder";
import { useMatchmakingFixtures, shogiQueue, rooms, fixture, connect } from "./matchmakingFixtures";

useMatchmakingFixtures();

test("再起動時に旧計測の保存待ちだけを消し、マッチングの待機状態を保持する", async () => {
  const queue = shogiQueue();
  const [user] = await fixture(1, queue);
  const status = await queue.status(user!.account.id, user!.controllerId, false);
  expect(status.status).toBe("waiting");
  const before = await runInDurableObject(queue, (_, state) => {
    state.storage.kv.delete("legacy-analytics-purged");
    const saved = [...state.storage.kv.list()];
    state.storage.kv.put("matchmaking-analytics-pending:first", { id: "old-event" });
    state.storage.kv.put("matchmaking-analytics-pending:second", { id: "other-event" });
    return saved;
  });
  await evictDurableObject(queue);
  expect(await queue.status(user!.account.id, user!.controllerId, false)).toMatchObject({
    ...status,
    serverNowMs: expect.any(Number),
  });
  await runInDurableObject(queue, (_, state) => {
    expect([...state.storage.kv.list({ prefix: "matchmaking-analytics-pending:" })]).toEqual([]);
    expect(state.storage.kv.get("legacy-analytics-purged")).toBe(true);
    expect(
      [...state.storage.kv.list()].filter(([key]) => key !== "legacy-analytics-purged"),
    ).toEqual(before);
  });
  await evictDurableObject(queue);
  expect(await queue.status(user!.account.id, user!.controllerId, false)).toMatchObject({
    ...status,
    serverNowMs: expect.any(Number),
  });
});

test.each([false, true])(
  "Usage Events は受付・成立・開始を書き、書き込み失敗=%sでもマッチングが成立する",
  async (fail) => {
    let now = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const events = recordUsageEvents(fail);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = shogiQueue();
    const users = await fixture(2, queue);
    const states = await Promise.all(users.map((u) => queue.status(u.account.id, u.controllerId)));
    const assignment = states[0]!.assignment!;
    rooms.add(assignment.roomId);
    expect(states.map((s) => s.status)).toEqual(["matched", "matched"]);
    for (const user of users) {
      expect(
        events.filter((e) => e.name === "matchmaking" && e.operationId === user.operationId),
      ).toContainEqual({
        name: "matchmaking",
        operationId: user.operationId,
        accountId: user.account.id,
        game: "shogi",
        stage: "accepted",
        reason: null,
        waitingMs: null,
        humans: null,
        rated: true,
        isTest: false,
      });
      expect(
        events.filter((e) => e.name === "matchmaking" && e.operationId === user.operationId),
      ).toContainEqual({
        name: "matchmaking",
        operationId: user.operationId,
        accountId: user.account.id,
        game: "shogi",
        stage: "matched",
        reason: null,
        waitingMs: 0,
        humans: 2,
        rated: true,
        isTest: false,
      });
    }
    for (const state of states)
      await connect(assignment.roomId, state.assignment!.membership.token);
    now += 5000;
    const room = env.GAME_ROOM.getByName(assignment.roomId);
    expect(await room.getRoom()).toMatchObject({ status: "playing" });
    for (const user of users)
      expect(
        events.filter((e) => e.name === "matchmaking" && e.operationId === user.operationId),
      ).toContainEqual({
        name: "matchmaking",
        operationId: user.operationId,
        accountId: user.account.id,
        browserId: null,
        game: "shogi",
        stage: "started",
        reason: null,
        humans: 2,
        rated: true,
        isTest: false,
      });
    expect(
      events.filter(
        (e) => e.name === "matchmaking" && users.some((user) => user.operationId === e.operationId),
      ),
    ).toHaveLength(6);
    expect(
      events.filter((e) => e.name === "match_started" && e.matchId === assignment.matchId),
    ).toEqual([
      expect.objectContaining({
        name: "match_started",
        matchId: assignment.matchId,
        matchKind: "rated",
        humans: 2,
        cpus: 0,
      }),
    ]);
    if (fail) expect(warn).toHaveBeenCalledWith("Usage event write failed");
  },
);

test("検索受付・取消は操作単位で一度だけ記録し、heartbeatと再送で計測を増やさない", async () => {
  const usage = recordUsageEvents();
  const [u] = await fixture(1, shogiQueue());
  const input = { operationId: u!.operationId, controllerId: u!.controllerId, version: 1 };
  await shogiQueue().join(u!.account.id, u!.operationId, u!.controllerId);
  await shogiQueue().control(u!.account.id, input, "heartbeat");
  await shogiQueue().control(u!.account.id, input, "cancel");
  await shogiQueue().control(u!.account.id, input, "cancel");
  const stages = usage
    .filter((e) => e.name === "matchmaking")
    .filter((e) => e.operationId === u!.operationId)
    .map((r) => r.stage);
  expect(stages).toEqual(["accepted", "cancelled"]);
});

test.each(["four-reversi", "four-shogi"] as const)(
  "%sのCPU枠不足は再試行で、復旧・DO再起動後の成立を最終失敗にしない",
  async (game) => {
    const usage = recordUsageEvents();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const prepare = GameRoom.prototype.prepareMatchmakingRoom;
    vi.spyOn(GameRoom.prototype, "prepareMatchmakingRoom").mockImplementation(function (
      this: GameRoom,
      input,
    ) {
      const original = Reflect.get(this, "env");
      Reflect.set(this, "env", {
        ...original,
        AI_SERVICE_URL: "https://ai.example.test",
        AI_SERVICE_TOKEN: "test-token-with-at-least-32-bytes",
      });
      return prepare.call(this, input).finally(() => Reflect.set(this, "env", original));
    });
    const queue = env.MATCHMAKING_COORDINATOR.getByName(matchmakingQueues[game].key);
    // 他の対局の非同期解放と競合しないよう、枠取得のRPC境界だけを制御します。
    let blocked = true;
    vi.spyOn(CpuCapacity.prototype, "reserve").mockImplementation(() => !blocked);
    const [u] = await fixture(1, queue);
    now += matchmakingQueues[game].fillAfterMs;
    await runInDurableObject(queue, (instance) => instance.alarm());
    expect((await queue.status(u!.account.id, u!.controllerId)).status).toBe("waiting");
    expect(
      usage.filter((e) => e.name === "matchmaking").filter((e) => e.operationId === u!.operationId),
    ).toContainEqual(expect.objectContaining({ stage: "retry", reason: "cpu_capacity" }));
    await evictDurableObject(queue);
    blocked = false;
    now += 2001;
    await runInDurableObject(queue, (instance) => instance.alarm());
    const state = await queue.status(u!.account.id, u!.controllerId);
    expect(state.status).toBe("matched");
    rooms.add(state.assignment!.roomId);
    const events = usage
      .filter((e) => e.name === "matchmaking")
      .filter((e) => e.operationId === u!.operationId);
    expect(events.filter((e) => e.stage === "failed")).toHaveLength(0);
    expect(events.filter((e) => e.stage === "matched")).toEqual([
      expect.objectContaining({
        humans: 1,
        waitingMs: matchmakingQueues[game].fillAfterMs + 2001,
      }),
    ]);
    expect(events.filter((e) => e.stage === "accepted")).toHaveLength(1);
    // AI準備の最終応答で閉鎖した割当も、同じ操作を再試行します。
    await runInDurableObject(env.GAME_ROOM.getByName(state.assignment!.roomId), (_, ctx) => {
      const key = `matchmaking:${state.assignment!.matchId}`;
      const reservation = ctx.storage.kv.get<Record<string, unknown>>(key)!;
      ctx.storage.kv.put(key, { ...reservation, phase: "closed", aiWarmup: { state: "failed" } });
    });
    await runInDurableObject(queue, (instance) => instance.alarm());
    expect(
      usage.filter((e) => e.name === "matchmaking").filter((e) => e.operationId === u!.operationId),
    ).toContainEqual(expect.objectContaining({ stage: "retry", reason: "ai_unavailable" }));
    const closed = await runInDurableObject(
      env.GAME_ROOM.getByName(state.assignment!.roomId),
      (_, ctx) =>
        ctx.storage.kv.get<{ players: { search?: unknown }[] }>(
          `matchmaking:${state.assignment!.matchId}`,
        )!,
    );
    expect(closed.players.every((p) => p.search === undefined)).toBe(true);

    expect(
      usage
        .filter((e) => e.name === "matchmaking")
        .filter((e) => e.operationId === u!.operationId)
        .some((e) => e.stage === "failed"),
    ).toBe(false);
    now += 5001;
    await runInDurableObject(queue, (instance) => instance.alarm());
    const again = await queue.status(u!.account.id, u!.controllerId);
    expect(again.status).toBe("matched");
    rooms.add(again.assignment!.roomId);
    expect(
      usage
        .filter((e) => e.name === "matchmaking")
        .filter((e) => e.operationId === u!.operationId)
        .filter((e) => e.stage === "matched"),
    ).toHaveLength(2);
  },
);

test("リース切れで検索を終えた最終失敗は、Alarmの再実行でも一度だけ計測する", async () => {
  const usage = recordUsageEvents();
  const [u] = await fixture(1, shogiQueue());
  await runInDurableObject(shogiQueue(), (_, ctx) => {
    const state = ctx.storage.kv.get<{ waiting: { expiresAtMs: number }[] }>("state")!;
    state.waiting[0]!.expiresAtMs = Date.now() - 1;
    ctx.storage.kv.put("state", state);
  });
  await runInDurableObject(shogiQueue(), (instance) => instance.alarm());
  await runInDurableObject(shogiQueue(), (instance) => instance.alarm());
  expect(
    usage.filter((e) => e.name === "matchmaking").filter((e) => e.operationId === u!.operationId),
  ).toContainEqual(expect.objectContaining({ stage: "failed", reason: "lease_expired" }));
  expect(
    usage
      .filter((e) => e.name === "matchmaking")
      .filter((e) => e.operationId === u!.operationId)
      .filter((e) => e.stage === "failed"),
  ).toHaveLength(1);
});
