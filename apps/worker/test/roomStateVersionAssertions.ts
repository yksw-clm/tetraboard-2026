import { runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";
import type { GameRoom } from "../src/durableObjects/gameRoom/gameRoom";
import { FourShogiProgress } from "../src/adapters/room/games/four-shogi/progress";
import { FourReversiProgress } from "../src/adapters/room/games/four-reversi/progress";
import { FourGomokuProgress } from "../src/adapters/room/games/four-gomoku/progress";
import {
  currentRoomStateVersion,
  roomStateVersionKey,
} from "../src/adapters/room/roomStateVersion";

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
