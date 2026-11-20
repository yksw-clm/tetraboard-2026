import { isReversiRoom, type Room } from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/reversi";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import type { RoomAlarmEvents } from "../src/adapters/room/roomAlarmEvents";
import { RoomBoundaryFixtures, boundaryRequest } from "./roomBoundaryFixtures";

let fixtures = new RoomBoundaryFixtures();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});

test("印の後にルームが保存されても、入口末尾のAlarmは最新の保存状態から計算する", async () => {
  const entry = await fixtures.create({ game: "reversi", name: "本人", quickPlay: true });
  await fixtures.connect(entry);
  await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), async (instance, ctx) => {
    await Reflect.get(instance, "runtime").jobs.roomIndexJob.running;
    const events = Reflect.get(instance, "alarmEvents") as RoomAlarmEvents;
    const lastActivityAtMs = Date.now() + 60_000;
    await events.run(async () => {
      const room = await instance.getRoom();
      expect(room).not.toBeNull();
      ctx.storage.kv.put("room", { ...room!, lastActivityAtMs });
    });
    expect(await ctx.storage.getAlarm()).toBe(lastActivityAtMs + 24 * 60 * 60 * 1000);
  });
});

test("外部AIの枠の予約RPCの前に、保存した解放期限のAlarmがある", async () => {
  const entry = await fixtures.create({
    game: "shogi",
    name: "本人",
    quickPlay: true,
    cpuLevel: 2,
  });
  await fixtures.connect(entry);
  await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), async (instance, ctx) => {
    await Reflect.get(instance, "runtime").jobs.roomIndexJob.running;
    const original = Reflect.get(instance, "env");
    const at = Date.now() + 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    const reserve = vi.fn(async () => {
      expect(
        ctx.storage.kv.get<{ releaseAtMs: number }>("external-cpu-capacity")?.releaseAtMs,
      ).toBe(at + 30_000);
      expect(await ctx.storage.getAlarm()).toBe(at + 30_000);
      return false;
    });
    Reflect.set(instance, "env", {
      ...original,
      AI_SHOGI_ENABLED: "true",
      AI_RATED_ONLY: "false",
      AI_SERVICE_TOKEN: "cpu-alarm-test-token-at-least-32-characters",
      AI_GATEWAY: { fetch: vi.fn() },
      CPU_CAPACITY: { getByName: () => ({ reserve }) },
    });
    try {
      await instance.webSocketMessage(
        ctx.getWebSockets()[0]!,
        JSON.stringify({ type: "room.game.start" }),
      );
      expect(reserve).toHaveBeenCalledTimes(1);
      await reserve.mock.results[0]!.value;
      expect(ctx.storage.kv.get("external-cpu-capacity")).toBeUndefined();
      expect(ctx.storage.kv.get<Room>("room")?.status).toBe("waiting");
    } finally {
      clock.mockRestore();
      Reflect.set(instance, "env", original);
    }
  });
});

test("GET・Alarm・開始・着手の同期部分は getAlarm が各1回以下、索引反映は別に1回", async () => {
  const entry = await fixtures.create({ game: "reversi", name: "本人", quickPlay: false });
  const guest = await fixtures.join(entry.room.id, "相手");
  await fixtures.connect(entry);
  await fixtures.connect(guest);
  await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), async (instance, ctx) => {
    const socketFor = (playerId: string) =>
      ctx.getWebSockets().find((socket) => {
        const attachment = socket.deserializeAttachment() as { tokenHash: string };
        return attachment.tokenHash === ctx.storage.kv.get(`player-token:${playerId}`);
      })!;
    for (const playerId of [entry.membership.playerId, guest.membership.playerId])
      await instance.webSocketMessage(
        socketFor(playerId),
        JSON.stringify({ type: "room.ready.set", ready: true }),
      );
    await Reflect.get(instance, "runtime").jobs.roomIndexJob.running;
    const readAlarm = ctx.storage.getAlarm.bind(ctx.storage);
    const stacks: string[] = [];
    const spy = vi.spyOn(ctx.storage, "getAlarm").mockImplementation(() => {
      stacks.push(new Error().stack ?? "");
      return readAlarm();
    });
    const check = (maxCompletedFlushes = 0) => {
      const background = stacks.filter((stack) => /RoomAlarmEvents.afterFlush/.test(stack));
      expect(stacks.length - background.length).toBeLessThanOrEqual(1);
      expect(background.length).toBeLessThanOrEqual(maxCompletedFlushes);
      stacks.length = 0;
    };
    try {
      await boundaryRequest(`/rooms/${entry.room.id}`);
      check();
      await instance.alarm();
      check();
      await instance.webSocketMessage(
        socketFor(entry.membership.playerId),
        JSON.stringify({ type: "room.game.start" }),
      );
      await Reflect.get(instance, "runtime").jobs.roomIndexJob.running;
      check(1);
      const room = ctx.storage.kv.get<Room>("room")!;
      expect(room.status).toBe("playing");
      if (!isReversiRoom(room) || room.status !== "playing") throw Error();
      const current = room.players.find((player) => player.color === room.game.turn)!;
      await instance.webSocketMessage(
        socketFor(current.id),
        JSON.stringify({
          type: "room.game.action",
          roundId: room.roundId,
          positionRevision: room.positionRevision,
          action: { type: "placeStone", position: getLegalMoves(room.game)[0] },
        }),
      );
      await Reflect.get(instance, "runtime").jobs.roomIndexJob.running;
      check(1);
      expect(ctx.storage.kv.get<Room>("room")?.game?.moveNumber).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

test("確定したルームは同期的なAlarm計算だけに渡し、延期した計算では読み直す", async () => {
  const { RoomAlarmEvents } = await import("../src/adapters/room/roomAlarmEvents");
  const inputs: (Room | null | undefined)[] = [];
  const room = { id: "synchronous-input" } as Room;
  const events = new RoomAlarmEvents(
    {},
    { getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} },
    (input) => {
      inputs.push(input);
      return null;
    },
    () => {},
  );
  events.withRoom(room, () => events.mark());
  await events.sync();
  expect(inputs).toEqual([room]);
  await events.run(async () => {
    events.withRoom(room, () => events.mark());
  });
  expect(inputs).toEqual([room, undefined]);
  events.mark();
  await events.sync();
  expect(inputs).toEqual([room, undefined, undefined]);
});
