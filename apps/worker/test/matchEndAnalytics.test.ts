import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import {
  analyticsActiveKey,
  analyticsPendingPrefix,
  type AnalyticsMatch,
  type AnalyticsJob,
} from "../src/analytics/store";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";
import { accountFixture } from "./accountFixtures";

test.each(gameIds)(
  "%sの終了理由は確定したゲームと各席を分け、D1障害・DO再起動後も一度保存する",
  async (game) => {
    const fixtures = new RoomBoundaryFixtures(),
      user = await accountFixture();
    let trigger: string | undefined;
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
      // 新しい計測のD1書き込みだけを失敗させます。対局・棋譜保存は実装を通します。
      trigger = `reject_lifecycle_${game.replaceAll("-", "_")}`;
      await env.APP_DB.exec(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON analytics_matches WHEN NEW.game='${game}' BEGIN SELECT RAISE(ABORT,'analytics unavailable'); END;`,
      );
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
      await vi.waitFor(async () => {
        const job = await runInDurableObject(stub, (_, ctx) =>
          ctx.storage.kv.get<AnalyticsJob>(analyticsPendingPrefix + active.id),
        );
        expect(job?.record).toMatchObject({ status: "completed", endReason: result!.reason });
      });
      await env.APP_DB.exec(`DROP TRIGGER ${trigger}`);
      trigger = undefined;
      await runInDurableObject(stub, (_, ctx) => {
        const job = ctx.storage.kv.get<AnalyticsJob>(analyticsPendingPrefix + active.id)!;
        ctx.storage.kv.put(analyticsPendingPrefix + active.id, {
          ...job,
          retryAtMs: Date.now() - 1,
        });
      });
      await evictDurableObject(stub);
      await runInDurableObject(stub, (instance) => instance.alarm());
      await vi.waitFor(async () =>
        expect(
          await env.APP_DB.prepare(
            "SELECT status,match_kind,human_count,end_reason FROM analytics_matches WHERE id=?",
          )
            .bind(active.id)
            .first(),
        ).toEqual({
          status: "completed",
          match_kind: "normal",
          human_count: gameCatalog[game].capacity,
          end_reason: result!.reason,
        }),
      );
      const endings = (
        await env.APP_DB.prepare("SELECT end_reason FROM analytics_participants WHERE match_id=?")
          .bind(active.id)
          .all<{ end_reason: string }>()
      ).results;
      expect(endings.filter((p) => p.end_reason === "left")).toHaveLength(others.length);
      expect(endings).toHaveLength(gameCatalog[game].capacity);
      expect(
        await env.APP_DB.prepare(
          "SELECT completion_is_guest FROM analytics_participants WHERE match_id=? AND origin_account_id=?",
        )
          .bind(active.id, user.id)
          .first("completion_is_guest"),
      ).toBe(0);
      await runInDurableObject(stub, (instance) => instance.alarm());
      expect(
        await env.APP_DB.prepare("SELECT COUNT(*) AS n FROM analytics_matches WHERE id=?")
          .bind(active.id)
          .first("n"),
      ).toBe(1);
    } finally {
      if (trigger) await env.APP_DB.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      await fixtures.dispose();
    }
  },
);
