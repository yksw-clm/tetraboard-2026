import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { analyticsActiveKey, type AnalyticsMatch } from "../src/usageEvents/matches";
import { recordUsageEvents } from "./usageEventsRecorder";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";
import { accountFixture } from "./accountFixtures";

test.each(gameIds)(
  "%sの開始・終了を新イベントへ記録し、DO再起動後も終了を重複させない",
  async (game) => {
    const fixtures = new RoomBoundaryFixtures(),
      user = await accountFixture();
    const events = recordUsageEvents();
    try {
      const entry = await fixtures.create(
        {
          name: "ホスト",
          game,
          quickPlay: false,
          ...(gameCatalog[game].hasModes ? { mode: "singles" } : {}),
        },
        user.cookie,
      );
      const host = await fixtures.open(entry.room.id);
      host.send({ type: "room.auth", token: entry.membership.token });
      expect((await host.waitFor("room.authenticated")).membership).toMatchObject({
        playerId: entry.membership.playerId,
        role: "host",
        accountLinked: true,
      });
      const others = [];
      for (let i = 1; i < gameCatalog[game].capacity; i++) {
        const joined = await fixtures.join(entry.room.id, `参加者${i}`);
        others.push({ socket: await fixtures.connect(joined), entry: joined });
      }
      for (const player of [host, ...others.map((p) => p.socket)])
        player.send({ type: "room.ready.set", ready: true });
      await host.waitFor("room.snapshot", (m) => m.room.players.every((p) => p.ready));
      host.send({ type: "room.game.start" });
      await host.waitFor("room.snapshot", (m) => m.room.status === "playing");
      const stub = env.GAME_ROOM.getByName(entry.room.id);
      const active = await runInDurableObject(stub, (_, ctx) =>
        ctx.storage.kv.get<AnalyticsMatch>(analyticsActiveKey)!,
      );
      expect(active).toMatchObject({
        matchKind: "normal",
        humanCount: gameCatalog[game].capacity,
        status: "playing",
      });
      for (const other of others) await fixtures.leave(other.entry);
      const finished = (await fixtures.snapshot(entry.room.id)).room;
      expect(finished.status).toBe("waiting");
      const result = finished.lastRound?.game.result;
      expect(result).toBeDefined();
      expect(events.filter((event) => event.name === "match_started")).toEqual([
        expect.objectContaining({
          matchId: active.id,
          game,
          matchKind: "normal",
          humans: gameCatalog[game].capacity,
          cpus: 0,
        }),
      ]);
      expect(events.filter((event) => event.name === "match_participant")).toHaveLength(
        gameCatalog[game].capacity,
      );
      const ended = () => events.filter((event) => event.name === "match_ended");
      expect(ended()).toEqual([
        expect.objectContaining({
          matchId: active.id,
          game,
          result: "completed",
          reason: result!.reason,
          durationMs: expect.any(Number),
        }),
      ]);
      await evictDurableObject(stub);
      await runInDurableObject(stub, (instance) => instance.alarm());
      await runInDurableObject(stub, (instance) => instance.alarm());
      expect(ended()).toHaveLength(1);
    } finally {
      await fixtures.dispose();
    }
  },
);
