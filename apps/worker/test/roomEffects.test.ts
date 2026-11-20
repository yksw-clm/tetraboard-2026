import { setReady, type RoomEffect } from "@tetraboard/context-room";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { TransactionRoomEffects } from "../src/adapters/room/effects";
import { withIndexTransaction } from "../src/adapters/room/transaction";
import { invokeRoomUseCase } from "../src/adapters/room/useCases";
import { roomStorageKey } from "../src/adapters/room/games/progressHelpers";
import type { RoomRuntime } from "../src/durableObjects/gameRoom/runtime";
import type { Room } from "@tetraboard/protocol";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

test.each([false, true])(
  "効果は最外側の確定を待ち、例外なら状態と一緒に捨てる（入れ子: %s）",
  async (nested) => {
    const fixtures = new RoomBoundaryFixtures();
    try {
      const entry = await fixtures.create({ game: "reversi", name: "本人", quickPlay: false });
      await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), (instance, ctx) => {
        const runtime = Reflect.get(instance, "runtime") as RoomRuntime;
        const original = runtime.effects;
        const published: RoomEffect[] = [];
        const visibleReady: boolean[] = [];
        runtime.effects = new TransactionRoomEffects((effect) => {
          published.push(effect);
          visibleReady.push(ctx.storage.kv.get<Room>(roomStorageKey)!.players[0].ready);
        });
        const hash = ctx.storage.kv.get<string>(`player-token:${entry.membership.playerId}`)!;
        const action = () => invokeRoomUseCase(runtime, (op) => setReady(op, hash, true));
        const update = () => (nested ? withIndexTransaction(runtime, action) : action());
        try {
          expect(() =>
            withIndexTransaction(runtime, () => {
              update();
              expect(published).toEqual([]);
              throw new Error("rollback effects");
            }),
          ).toThrow("rollback effects");
          expect(ctx.storage.kv.get<Room>(roomStorageKey)!.players[0].ready).toBe(false);
          expect(published).toEqual([]);
          withIndexTransaction(runtime, () => {
            expect(update().status).toBe("updated");
            expect(published).toEqual([]);
          });
          expect(published).toEqual([
            { type: "broadcastRoom", room: ctx.storage.kv.get(roomStorageKey) },
          ]);
          expect(visibleReady).toEqual([true]);
        } finally {
          runtime.effects = original;
        }
      });
    } finally {
      await fixtures.dispose();
    }
  },
);
