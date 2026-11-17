import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import * as accounts from "../src/accounts/roomAccounts";
import { publicMetadata } from "../src/adapters/room/metadata";
import * as indexes from "../src/rooms/roomIndex";
import type { RoomJob } from "../src/rooms/roomJobs";
import {
  pendingTournamentStatePrefix,
  type PendingTournamentState,
} from "@tetraboard/context-tournament";
import * as tournaments from "../src/adapters/tournament/state";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

function barrier(fail: boolean) {
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  return {
    started,
    release,
    execute: async () => {
      started.resolve();
      await release.promise;
      if (fail) throw new Error("old job failed");
    },
  };
}

for (const fail of [false, true]) {
  test(`索引の反映中に版が進んだら、古い完了と再送は新しい版を消さない（失敗=${fail}）`, async () => {
    const fixtures = new RoomBoundaryFixtures();
    try {
      const entry = await fixtures.create({ game: "reversi", name: "本人", quickPlay: true });
      await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), async (instance, ctx) => {
        const job = Reflect.get(instance, "runtime").jobs.roomIndexJob as RoomJob<unknown>;
        await job.running;
        const gate = barrier(fail);
        const spy = vi.spyOn(indexes, "writeRoomIndex").mockImplementation(gate.execute);
        try {
          const pending = {
            revision: ctx.storage.kv.get<number>("room-index-revision")! + 1,
            metadata: publicMetadata(Reflect.get(instance, "runtime"), entry.room),
            closed: false,
            retryAtMs: Date.now(),
          };
          ctx.storage.kv.put("room-index-pending", pending);
          const running = job.flush();
          await gate.started.promise;
          const latest = {
            ...pending,
            revision: pending.revision + 1,
            retryAtMs: Date.now() + 60_000,
          };
          ctx.storage.kv.put("room-index-pending", latest);
          gate.release.resolve();
          await running;
          expect(ctx.storage.kv.get("room-index-pending")).toEqual(latest);
          expect(job.nextAlarmAt()).toBe(latest.retryAtMs);
          expect(spy).toHaveBeenCalledTimes(1);
        } finally {
          gate.release.resolve();
          spy.mockRestore();
          ctx.storage.kv.delete("room-index-pending");
        }
      });
    } finally {
      await fixtures.dispose();
    }
  });

  test(`席の反映中に追加した画像解放と別の操作IDを残す（失敗=${fail}）`, async () => {
    const stub = env.GAME_ROOM.getByName(`cleanup-fence-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, ctx) => {
      const job = Reflect.get(instance, "runtime").jobs.accountCleanupJob as RoomJob<unknown>;
      const gate = barrier(fail);
      const spy = vi.spyOn(accounts, "releaseReservation").mockImplementation(gate.execute);
      const reservation = {
        accountId: "account",
        operationId: "old-operation",
        roomId: "12345",
        instanceId: crypto.randomUUID(),
        playerId: crypto.randomUUID(),
        name: "本人",
        avatarKey: "image",
      };
      const initial = { reservation, releaseAvatar: false, retryAtMs: Date.now() };
      try {
        ctx.storage.kv.put("account-cleanups", [initial]);
        ctx.storage.kv.put("cancelled-admission:old-operation", true);
        const running = job.flush();
        await gate.started.promise;
        const upgraded = { ...initial, releaseAvatar: true, retryAtMs: Date.now() + 60_000 };
        const other = {
          ...upgraded,
          reservation: { ...reservation, operationId: "new-operation" },
        };
        ctx.storage.kv.put("account-cleanups", [upgraded, other]);
        gate.release.resolve();
        await running;
        const latest = ctx.storage.kv.get<(typeof initial)[]>("account-cleanups")!;
        expect(latest[0]).toMatchObject({ reservation, releaseAvatar: true });
        expect(latest[1]).toEqual(other);
        if (fail) expect(latest[0]!.retryAtMs).toBeLessThan(upgraded.retryAtMs);
        else expect(latest[0]).toEqual(upgraded);
        expect(ctx.storage.kv.get("cancelled-admission:old-operation")).toBe(true);
        spy.mockResolvedValue(undefined);
        ctx.storage.kv.put("account-cleanups", [{ ...latest[0], retryAtMs: 0 }, other]);
        await job.flush();
        expect(spy.mock.calls.map((call) => [call[1].operationId, call[2]])).toEqual([
          ["old-operation", false],
          ["old-operation", true],
        ]);
        expect(ctx.storage.kv.get("account-cleanups")).toEqual([other]);
        expect(ctx.storage.kv.get("cancelled-admission:old-operation")).toBeUndefined();
      } finally {
        gate.release.resolve();
        spy.mockRestore();
        ctx.storage.kv.delete("account-cleanups");
        await ctx.storage.deleteAlarm();
      }
    });
  });

  test(`大会の反映中にphaseが進んだら、古い完了と再送は新しいphaseを消さない（失敗=${fail}）`, async () => {
    const stub = env.GAME_ROOM.getByName(`tournament-fence-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, ctx) => {
      const job = Reflect.get(instance, "runtime").jobs.tournamentStateJob as RoomJob<unknown>;
      const gate = barrier(fail);
      const spy = vi.spyOn(tournaments, "writeTournamentState").mockImplementation(gate.execute);
      const pending: PendingTournamentState = {
        phase: "playing",
        retryAtMs: Date.now(),
        reservation: {
          roomId: "12345",
          instanceId: crypto.randomUUID(),
          status: "playing",
          preparedAtMs: Date.now(),
          context: {
            matchId: crypto.randomUUID(),
            tournamentKey: "key",
            tournamentId: 1,
            ruleVersion: 1,
            startsAtMs: 0,
            endsAtMs: Date.now() + 60_000,
          },
        },
      };
      const key = pendingTournamentStatePrefix + pending.reservation.context.matchId;
      try {
        ctx.storage.kv.put(key, pending);
        const running = job.flush();
        await gate.started.promise;
        const latest = { ...pending, phase: "saving", retryAtMs: Date.now() + 60_000 };
        ctx.storage.kv.put(key, latest);
        gate.release.resolve();
        await running;
        expect(ctx.storage.kv.get(key)).toEqual(latest);
        expect(job.nextAlarmAt()).toBe(latest.retryAtMs);
        spy.mockResolvedValue(undefined);
        ctx.storage.kv.put(key, { ...latest, retryAtMs: 0 });
        await job.flush();
        expect(spy.mock.calls.map((call) => call[1].phase)).toEqual(["playing", "saving"]);
        expect(ctx.storage.kv.get(key)).toBeUndefined();
      } finally {
        gate.release.resolve();
        spy.mockRestore();
        ctx.storage.kv.delete(key);
        await ctx.storage.deleteAlarm();
      }
    });
  });
}
