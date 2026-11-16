import { expectVersionedRoom } from "./roomStateVersionAssertions";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { gameIds, type Room } from "@tetraboard/protocol";
import { RoomBoundaryFixtures, boundaryRequest } from "./roomBoundaryFixtures";
import { FourShogiProgress } from "../src/rooms/fourShogiProgress";
import { currentRoomStateVersion, roomStateVersionKey } from "../src/rooms/roomStateVersion";

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
  test(`${game}: 新規作成は版1、版の欠落でも状態は変わらず、閉鎖は版も削除する`, async () => {
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
      try {
        await boundaryRequest(`/rooms/${entry.room.id}`);
        const getReads = read.mock.calls.filter(([key]) => key === "room").length;
        expect(getReads).toBeGreaterThan(0);
        expect(getReads).toBeLessThanOrEqual(roomReadLimits[game].get);
        read.mockClear();
        await instance.alarm();
        const alarmReads = read.mock.calls.filter(([key]) => key === "room").length;
        expect(alarmReads).toBeGreaterThan(0);
        expect(alarmReads).toBeLessThanOrEqual(roomReadLimits[game].alarm);
      } finally {
        read.mockRestore();
      }
    });
  });
}
const roomReadLimits = {
  "four-reversi": { get: 6, alarm: 6 },
  reversi: { get: 6, alarm: 6 },
  "four-shogi": { get: 7, alarm: 7 },
  shogi: { get: 7, alarm: 7 },
  gomoku: { get: 6, alarm: 6 },
  "four-gomoku": { get: 6, alarm: 6 },
};
