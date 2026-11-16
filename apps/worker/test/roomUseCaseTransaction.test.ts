import { setTimeControl, closeRoom } from "@tetraboard/context-room";
import type { Room } from "@tetraboard/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { invokeRoomTransaction } from "../src/adapters/room/useCaseTransaction";
import { withIndexTransaction } from "../src/adapters/room/transaction";
import { TransactionRoomEffects } from "../src/adapters/room/effects";
import type { PendingRoomIndex } from "../src/rooms/roomIndex";
import type { RoomRuntime } from "../src/durableObjects/gameRoom/runtime";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

let fixtures = new RoomBoundaryFixtures();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});

test.each(["変更", "同値", "拒否", "閉鎖"] as const)(
  "%s: 一度読んだ前の値と最後の保存値から索引を作り、読み直さない",
  async (kind) => {
    const entry = await fixtures.create({ game: "reversi", name: "本人", quickPlay: false });
    await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), async (instance, ctx) => {
      const runtime = Reflect.get(instance, "runtime") as RoomRuntime;
      await runtime.jobs.roomIndexJob.running;
      const hash = ctx.storage.kv.get<string>(`player-token:${entry.membership.playerId}`)!;
      const original = ctx.storage.kv.get<Room>("room")!;
      await Reflect.get(instance, "alarmEvents").run(async () => {
        const get = vi.spyOn(ctx.storage.kv, "get");
        try {
          const result = invokeRoomTransaction(runtime, (op) => {
            if (kind === "閉鎖") return closeRoom(op);
            return setTimeControl(
              op,
              kind === "拒否" ? "invalid-token" : hash,
              kind === "同値"
                ? original.settings.timeControl
                : { mainTimeMs: 300_000, byoyomiMs: 0 },
            );
          });
          expect(get.mock.calls.filter(([key]) => key === "room")).toHaveLength(1);
          if (kind === "変更") {
            expect(result).toMatchObject({ status: "updated" });
            expect(ctx.storage.kv.get<PendingRoomIndex>("room-index-pending")).toMatchObject({
              closed: false,
              metadata: { timeControl: { mainTimeMs: 300_000, byoyomiMs: 0 } },
            });
          } else if (kind === "閉鎖") {
            expect(ctx.storage.kv.get("room")).toBeUndefined();
            expect(ctx.storage.kv.get<PendingRoomIndex>("room-index-pending")).toMatchObject({
              closed: true,
            });
          } else {
            expect(result).toMatchObject({ status: kind === "同値" ? "unchanged" : "forbidden" });
            expect(ctx.storage.kv.get("room")).toEqual(original);
          }
        } finally {
          get.mockRestore();
        }
      });
    });
    if (kind === "閉鎖") fixtures.forgetClosedRoom(entry.room.id);
  },
);

test("最後の保存値の追跡は複数保存、外側のロールバック、再試行をまたいで混ざらない", async () => {
  const entry = await fixtures.create({ game: "reversi", name: "本人", quickPlay: false });
  await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), async (instance, ctx) => {
    const runtime = Reflect.get(instance, "runtime") as RoomRuntime;
    await runtime.jobs.roomIndexJob.running;
    const before = ctx.storage.kv.get<Room>("room")!;
    await Reflect.get(instance, "alarmEvents").run(async () => {
      const originalEffects = runtime.effects;
      const visible: unknown[] = [];
      runtime.effects = new TransactionRoomEffects((effect) => visible.push(effect));
      const save = () =>
        invokeRoomTransaction(runtime, (op) => {
          op.state.saveRoom({ ...before, publicUpdatedAtMs: before.publicUpdatedAtMs + 1 });
          op.state.saveRoom({ ...before, publicUpdatedAtMs: before.publicUpdatedAtMs + 2 });
          op.effects.push({ type: "broadcastRoom", room: before });
        });
      try {
        expect(() =>
          withIndexTransaction(runtime, () => {
            save();
            expect(visible).toEqual([]);
            throw new Error("rollback tracked state");
          }),
        ).toThrow("rollback tracked state");
        expect(ctx.storage.kv.get("room")).toEqual(before);
        expect(visible).toEqual([]);
        save();
        expect(ctx.storage.kv.get<PendingRoomIndex>("room-index-pending")).toMatchObject({
          metadata: { updatedAtMs: before.publicUpdatedAtMs + 2 },
        });
        expect(visible).toHaveLength(1);
      } finally {
        runtime.effects = originalEffects;
      }
    });
  });
});
