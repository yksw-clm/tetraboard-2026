import { expectVersionedRoom } from "./roomStateVersionAssertions";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { fourReversiRoomSchema, gameIds, roundReplaySchema, type Room } from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/four-reversi";
import { RoomBoundaryFixtures, boundaryRequest } from "./roomBoundaryFixtures";
import { FourShogiProgress } from "../src/adapters/room/games/four-shogi/progress";
import {
  currentRoomStateVersion,
  roomStateVersionKey,
} from "../src/adapters/room/roomStateVersion";

let fixtures = new RoomBoundaryFixtures();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});
async function create(game: (typeof gameIds)[number] = "four-shogi") {
  return fixtures.create({
    game,
    name: "本人",
    quickPlay: true,
    ...(game.startsWith("four-") ? { mode: "singles" } : {}),
  });
}
async function legacyRoom() {
  const entry = await create();
  const host = await fixtures.connect(entry);
  host.send({ type: "room.game.start" });
  const { room } = await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
  const stub = env.GAME_ROOM.getByName(room.id);
  await runInDurableObject(stub, (_, ctx) => {
    const saved = ctx.storage.kv.get<Room>("room")!;
    if (!saved.game) throw Error();
    Reflect.deleteProperty(saved.game, "drawProposals");
    ctx.storage.kv.put("room", saved);
    ctx.storage.kv.delete(roomStateVersionKey);
  });
  return { room, stub };
}

test.each(["waiting", "playing"] as const)(
  "四人リバーシ %s: 保存版2の局IDと局面の版をGET・WebSocketで配信し、対局を継続できる",
  async (status) => {
    const host = await fixtures.create({
      game: "four-reversi",
      name: "ホスト",
      quickPlay: false,
      mode: "singles",
    });
    const { id, instanceId } = host.room;
    const stub = env.GAME_ROOM.getByName(id);
    const entries = [host];
    if (status === "playing") {
      for (const name of ["参加者1", "参加者2", "参加者3"])
        entries.push(await fixtures.join(id, name));
      const sockets = await Promise.all(entries.map((entry) => fixtures.connect(entry)));
      const [hostSocket] = sockets;
      for (const [index, socket] of sockets.entries()) {
        const playerId = entries[index].membership.playerId;
        socket.send({ type: "room.ready.set", ready: true });
        await hostSocket.waitFor("room.snapshot", (m) =>
          m.room.players.some((player) => player.id === playerId && player.ready),
        );
      }
      hostSocket.send({ type: "room.game.start" });
      await hostSocket.waitFor("room.snapshot", (m) => m.room.status === "playing");
    }

    const readV2 = () =>
      runInDurableObject(stub, (_, ctx) => {
        expect(ctx.storage.kv.get(roomStateVersionKey)).toBe(2);
        return {
          room: fourReversiRoomSchema.parse(ctx.storage.kv.get("room")),
          replay: roundReplaySchema.optional().parse(ctx.storage.kv.get("round-replay")),
        };
      });
    const before = await readV2();
    expect(before.room.status).toBe(status);
    await evictDurableObject(stub, { webSockets: "hibernate" });

    expect(await stub.getShareMetadata(instanceId)).toEqual({
      id,
      instanceId,
      settings: { game: "four-reversi" },
    });
    expect(await readV2()).toEqual(before);
    expect((await fixtures.snapshot(id)).room).toEqual(before.room);

    const { room } = before;
    const mover = entries.find((entry) =>
      room.players.some(
        (player) =>
          player.id === entry.membership.playerId && player.color === (room.game?.turn ?? null),
      ),
    );
    if (!mover) throw new Error("Expected a player for the current turn");
    const socket = await fixtures.open(id);
    socket.send({ type: "room.auth", token: mover.membership.token });
    expect((await socket.waitFor("room.authenticated")).membership.playerId).toBe(
      mover.membership.playerId,
    );
    const connectedRoom = {
      ...room,
      players: room.players.map((player) =>
        player.id === mover.membership.playerId ? { ...player, reconnectDeadline: null } : player,
      ),
    };
    expect((await socket.waitFor("room.snapshot")).room).toEqual(connectedRoom);
    expect(await readV2()).toEqual({ ...before, room: connectedRoom });

    if (room.status !== "playing") return;
    const [position] = getLegalMoves(room.game);
    socket.send({
      type: "room.game.action",
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      action: { type: "placeStone", position },
    });
    const { room: moved } = await socket.waitFor(
      "room.snapshot",
      (m) => m.room.game?.moveNumber === 1,
    );
    expect(moved).toMatchObject({
      roundId: room.roundId,
      positionRevision: room.positionRevision + 1,
      game: { lastMove: position },
    });
    const after = await readV2();
    expect(after.room).toEqual(moved);
    expect(after.replay?.id).toBe(before.replay?.id);
    expect(after.replay?.steps).toHaveLength(1);
  },
);

test.each(["waiting", "playing"] as const)(
  "通常リバーシ %s: 脱落配列の欠落は移行で補わず、失敗した状態も保存しない",
  async (status) => {
    const entry = await create("reversi");
    if (status === "playing") {
      const host = await fixtures.connect(entry);
      host.send({ type: "room.game.start" });
      await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
    }
    await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), async (instance, ctx) => {
      const original = ctx.storage.kv.get<Room>("room")!;
      const saved = structuredClone(original);
      Reflect.deleteProperty(saved, "eliminations");
      ctx.storage.kv.put("room", saved);
      ctx.storage.kv.delete(roomStateVersionKey);
      const read = vi.spyOn(ctx.storage.kv, "get");
      try {
        expect(await instance.getShareMetadata(entry.room.instanceId)).toBeNull();
        await expect(instance.getRoom()).rejects.toThrow("eliminations");
        expect(ctx.storage.kv.get("room")).toEqual(saved);
        expect(ctx.storage.kv.get(roomStateVersionKey)).toBeUndefined();
        expect(read.mock.calls.filter(([key]) => key === "round-replay")).toHaveLength(0);
      } finally {
        read.mockRestore();
        ctx.storage.kv.put("room", original);
        ctx.storage.kv.put(roomStateVersionKey, currentRoomStateVersion);
      }
    });
  },
);

test("共有の移行は保存せず、通常の読み込みは最初の一度だけ移行して保存する", async () => {
  const { room, stub } = await legacyRoom();
  await runInDurableObject(stub, async (instance, ctx) => {
    const saved = ctx.storage.kv.get("room");
    const migrate = vi.spyOn(FourShogiProgress.prototype, "migrateLegacy");
    try {
      expect(await instance.getShareMetadata(room.instanceId)).toEqual({
        id: room.id,
        instanceId: room.instanceId,
        settings: { game: "four-shogi" },
      });
      expect(migrate).toHaveBeenCalledTimes(1);
      expect(ctx.storage.kv.get("room")).toEqual(saved);
      expect(ctx.storage.kv.get(roomStateVersionKey)).toBeUndefined();
      migrate.mockClear();
      expect(await instance.getRoom()).toEqual(room);
      expect(migrate).toHaveBeenCalledTimes(1);
      expect(ctx.storage.kv.get("room")).toEqual(room);
      expect(ctx.storage.kv.get(roomStateVersionKey)).toBe(currentRoomStateVersion);
      migrate.mockClear();
      expect(await instance.getRoom()).toEqual(room);
      await instance.getShareMetadata(room.instanceId);
      expect(migrate).not.toHaveBeenCalled();
    } finally {
      migrate.mockRestore();
    }
  });
});

test("現在の版では古い状態を補わず、共有はnull、通常読み込みはschemaのエラーを返す", async () => {
  const { room, stub } = await legacyRoom();
  await runInDurableObject(stub, async (instance, ctx) => {
    ctx.storage.kv.put(roomStateVersionKey, currentRoomStateVersion);
    const saved = ctx.storage.kv.get("room");
    const migrate = vi.spyOn(FourShogiProgress.prototype, "migrateLegacy");
    try {
      expect(await instance.getShareMetadata(room.instanceId)).toBeNull();
      await expect(instance.getRoom()).rejects.toThrow();
      expect(ctx.storage.kv.get("room")).toEqual(saved);
      expect(ctx.storage.kv.get(roomStateVersionKey)).toBe(currentRoomStateVersion);
      expect(migrate).not.toHaveBeenCalled();
    } finally {
      migrate.mockRestore();
      ctx.storage.kv.put("room", room);
    }
  });
});

test("版の保存に失敗すると移行した状態も戻り、再試行できる", async () => {
  const { room, stub } = await legacyRoom();
  await runInDurableObject(stub, async (instance, ctx) => {
    const saved = ctx.storage.kv.get("room");
    const put = ctx.storage.kv.put.bind(ctx.storage.kv);
    const writes = vi.spyOn(ctx.storage.kv, "put").mockImplementation((key, value) => {
      if (key === roomStateVersionKey) throw Error("版の保存失敗");
      put(key, value);
    });
    try {
      await expect(instance.getRoom()).rejects.toThrow("版の保存失敗");
      expect(ctx.storage.kv.get("room")).toEqual(saved);
      expect(ctx.storage.kv.get(roomStateVersionKey)).toBeUndefined();
    } finally {
      writes.mockRestore();
    }
    expect(await instance.getRoom()).toEqual(room);
    expect(ctx.storage.kv.get(roomStateVersionKey)).toBe(currentRoomStateVersion);
  });
});

test("transactionSyncを入れ子にしても、外側の例外で状態と版が一緒に戻る", async () => {
  const entry = await create();
  await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), (_, ctx) => {
    const before = [...ctx.storage.kv.list()];
    expect(() =>
      ctx.storage.transactionSync(() => {
        ctx.storage.transactionSync(() => {
          ctx.storage.kv.put("room", { ...entry.room, lastActivityAtMs: 1 });
          ctx.storage.kv.put(roomStateVersionKey, 0);
        });
        expect(ctx.storage.kv.get(roomStateVersionKey)).toBe(0);
        throw Error("外側の保存失敗");
      }),
    ).toThrow("外側の保存失敗");
    expect([...ctx.storage.kv.list()]).toEqual(before);
    ctx.storage.transactionSync(() =>
      ctx.storage.transactionSync(() => {
        ctx.storage.kv.put("room", entry.room);
        ctx.storage.kv.put(roomStateVersionKey, currentRoomStateVersion);
      }),
    );
    expect(ctx.storage.kv.get("room")).toEqual(entry.room);
    expect(ctx.storage.kv.get(roomStateVersionKey)).toBe(currentRoomStateVersion);
  });
});

for (const game of gameIds) {
  test(`${game}: 新規作成は現行版、版の欠落でも状態は変わらず、閉鎖は版も削除する`, async () => {
    const entry = await create(game);
    const stub = env.GAME_ROOM.getByName(entry.room.id);
    await expectVersionedRoom(stub);
    await runInDurableObject(stub, async (instance, ctx) => {
      expect(ctx.storage.kv.get(roomStateVersionKey)).toBe(currentRoomStateVersion);
      const before = await instance.getRoom();
      ctx.storage.kv.delete(roomStateVersionKey);
      expect(await instance.getRoom()).toEqual(before);
      expect(ctx.storage.kv.get("room")).toEqual(before);
      expect(ctx.storage.kv.get(roomStateVersionKey)).toBe(currentRoomStateVersion);
    });
    await fixtures.leave(entry);
    await runInDurableObject(stub, async (instance, ctx) => {
      expect(ctx.storage.kv.get("room")).toBeUndefined();
      expect(ctx.storage.kv.get(roomStateVersionKey)).toBeUndefined();
      expect(await instance.getRoom()).toBeNull();
    });
  });

  test(`${game}: CPU付きルームのGETとAlarmでroomの読み込み回数を増やさない`, async () => {
    const entry = await create(game);
    const host = await fixtures.connect(entry);
    host.send({ type: "room.game.start" });
    await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
    await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), async (instance, ctx) => {
      const read = vi.spyOn(ctx.storage.kv, "get");
      const alarm = vi.spyOn(ctx.storage, "getAlarm");
      try {
        await boundaryRequest(`/rooms/${entry.room.id}`);
        const getReads = read.mock.calls.filter(([key]) => key === "room").length;
        expect(alarm).toHaveBeenCalledTimes(1);
        alarm.mockClear();
        expect(getReads).toBeGreaterThan(0);
        expect(getReads).toBeLessThanOrEqual(roomReadLimits[game].get);
        read.mockClear();
        await instance.alarm();
        const alarmReads = read.mock.calls.filter(([key]) => key === "room").length;
        expect(alarm).toHaveBeenCalledTimes(1);
        expect(alarmReads).toBeGreaterThan(0);
        expect(alarmReads).toBeLessThanOrEqual(roomReadLimits[game].alarm);
      } finally {
        read.mockRestore();
        alarm.mockRestore();
      }
    });
  });
}
const roomReadLimits = {
  "four-reversi": { get: 4, alarm: 4 },
  reversi: { get: 4, alarm: 4 },
  "four-shogi": { get: 4, alarm: 4 },
  shogi: { get: 4, alarm: 4 },
  gomoku: { get: 4, alarm: 4 },
  "four-gomoku": { get: 4, alarm: 4 },
};
