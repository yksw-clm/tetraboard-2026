import { runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";
import type { GameRoom } from "../src/durableObjects/gameRoom/gameRoom";
import { FourShogiProgress } from "../src/rooms/fourShogiProgress";
import { FourReversiProgress } from "../src/rooms/fourReversiProgress";
import { FourGomokuProgress } from "../src/rooms/fourGomokuProgress";
import { currentRoomStateVersion, roomStateVersionKey } from "../src/rooms/roomStateVersion";

export async function expectVersionedRoom(stub: DurableObjectStub<GameRoom>) {
  await runInDurableObject(stub, async (instance, ctx) => {
    expect(ctx.storage.kv.get(roomStateVersionKey)).toBe(currentRoomStateVersion);
    const migrations = [
      vi.spyOn(FourShogiProgress.prototype, "migrateLegacy"),
      vi.spyOn(FourReversiProgress.prototype, "migrateLegacy"),
      vi.spyOn(FourGomokuProgress.prototype, "migrateLegacy"),
    ];
    try {
      const room = await instance.getRoom();
      expect(room).not.toBeNull();
      await instance.getShareMetadata(room!.instanceId);
      for (const migration of migrations) expect(migration).not.toHaveBeenCalled();
    } finally {
      for (const migration of migrations) migration.mockRestore();
    }
  });
}
