import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { shogiRoomSchema } from "@tetraboard/protocol";
import type { ShogiCpuJob } from "../src/rooms/standardShogiProgress";
import { RoomBoundaryFixtures } from "../test/roomBoundaryFixtures";

let fixtures = new RoomBoundaryFixtures();
let now: number;
afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});

async function setup() {
  const entry = await fixtures.create({
    game: "shogi",
    name: "人間",
    quickPlay: true,
    cpuLevel: 2,
  });
  const host = await fixtures.connect(entry);
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  const read = () =>
    runInDurableObject(stub, (_, ctx) => shogiRoomSchema.parse(ctx.storage.kv.get("room")));
  const job = () =>
    runInDurableObject(stub, (_, ctx) => ctx.storage.kv.get<ShogiCpuJob>("standard-shogi-cpu-job"));
  host.send({ type: "room.game.start" });
  let before = shogiRoomSchema.parse(
    (await host.waitFor("room.snapshot", (message) => message.room.status === "playing")).room,
  );
  if (before.status !== "playing") throw Error("Expected playing");
  if (before.game.players.south === entry.membership.playerId) {
    host.send({
      type: "room.game.action",
      roundId: before.roundId,
      positionRevision: before.positionRevision,
      action: { type: "movePiece", from: { x: 2, y: 6 }, to: { x: 2, y: 5 }, promote: false },
    });
    before = shogiRoomSchema.parse(
      (await host.waitFor("room.snapshot", (message) => message.room.game?.moveNumber === 1)).room,
    );
  }
  if (before.status !== "playing") throw Error("Expected CPU turn");
  const alarm = (timeout = "5000") =>
    runInDurableObject(stub, async (instance) => {
      const original = Reflect.get(instance, "env");
      Reflect.set(instance, "env", {
        ...original,
        AI_SHOGI_ENABLED: "true",
        AI_SERVICE_TIMEOUT_MS: timeout,
      });
      try {
        await instance.alarm();
      } finally {
        Reflect.set(instance, "env", original);
      }
    });
  return { before, alarm, read, job };
}

test("将棋の棋譜をUSIで送り、照合した候補手を次のAlarmで一度だけ反映する", async () => {
  now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { before, alarm, read, job } = await setup();
  now = before.clock.turnStartedAt + 2000;
  const best = before.game.turn === "south" ? "9g9f" : "9c9d";
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(new URL(String(url)).pathname).toBe("/v1/shogi/move");
    const request = JSON.parse(String(options?.body));
    expect(request.moves).toEqual(before.game.moveNumber === 0 ? [] : ["7g7f"]);
    return Response.json({
      request_id: request.request_id,
      position_revision: request.position_revision,
      engine_version: "yaneuraou-material-faeb37f0",
      nodes: 256,
      best_move: best,
    });
  });
  await alarm();
  const pending = await job();
  expect(pending?.action).toEqual({
    type: "movePiece",
    from: { x: 0, y: before.game.turn === "south" ? 6 : 2 },
    to: { x: 0, y: before.game.turn === "south" ? 5 : 3 },
    promote: false,
  });
  expect((await read()).game?.moveNumber).toBe(before.game.moveNumber);
  now = pending!.applyAt;
  await alarm();
  await alarm();
  expect((await read()).game?.moveNumber).toBe(before.game.moveNumber + 1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("将棋AIの応答が期限内に届かなければ既存CPUの合法手を保存する", async () => {
  now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { before, alarm, job, read } = await setup();
  now = before.clock.turnStartedAt + 2000;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
    (_, options) =>
      new Promise((_, reject) =>
        options?.signal?.addEventListener("abort", () => reject(Error("aborted")), {
          once: true,
        }),
      ),
  );
  await alarm("100");
  const fallback = await job();
  expect(fallback).toBeDefined();
  expect(before.legalActions).toContainEqual(fallback?.action);
  now = fallback!.applyAt;
  await alarm();
  expect((await read()).game?.moveNumber).toBe(before.game.moveNumber + 1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("応答待ちに将棋の時計が切れたら、候補手を適用せず時間切れを確定する", async () => {
  now = Date.now() + 60000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { before, alarm, job, read } = await setup();
  now = before.clock.turnStartedAt + 2000;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, options) => {
    const request = JSON.parse(String(options?.body));
    now = before.clock.turnExpiresAt;
    return Response.json({
      request_id: request.request_id,
      position_revision: request.position_revision,
      engine_version: "yaneuraou-material-faeb37f0",
      nodes: 256,
      best_move: before.game.turn === "south" ? "9g9f" : "9c9d",
    });
  });
  await alarm();
  const ended = await read();
  expect(ended.status).toBe("waiting");
  expect(ended.lastRound?.game.moveNumber).toBe(before.game.moveNumber);
  expect(ended.lastRound?.game.result?.reason).toBe("timeout");
  expect(await job()).toBeUndefined();
});

test.skipIf(env.AI_SHOGI_ENABLED !== "true")(
  "4つの将棋ルームが同時に実エンジンへ着手を要求し、それぞれ合法手を反映する",
  async () => {
    now = Date.now() + 60000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const rooms = await Promise.all(Array.from({ length: 4 }, () => setup()));
    now = Math.max(...rooms.map(({ before }) => before.clock.turnStartedAt)) + 2000;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await Promise.all(rooms.map(({ alarm }) => alarm()));
    const engineReplies = await Promise.all(
      fetchSpy.mock.results.map(({ value }) => value as Promise<Response>),
    );
    expect(engineReplies).toHaveLength(4);
    expect(engineReplies.every((reply) => reply.ok)).toBe(true);
    const jobs = await Promise.all(rooms.map(({ job }) => job()));
    expect(
      jobs.every((job, i) =>
        rooms[i].before.legalActions.some(
          (move) => job?.external && JSON.stringify(move) === JSON.stringify(job.action),
        ),
      ),
    ).toBe(true);
    now = Math.max(...jobs.map((job) => job!.applyAt));
    await Promise.all(rooms.map(({ alarm }) => alarm()));
    for (const { read, before } of rooms)
      expect((await read()).game?.moveNumber).toBe(before.game.moveNumber + 1);
  },
);
