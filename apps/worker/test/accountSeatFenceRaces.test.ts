import { beforeAll, expect, test } from "vitest";
import { ratedMatchmakingPolicy } from "../src/adapters/matchmaking/ratedMatchmaking";
import { joinWait } from "../src/adapters/matchmaking/joinWrites";
import { D1TournamentQueueStore } from "../src/adapters/tournament/queue";
import {
  fenceDatabases,
  initializeFenceDatabase,
  fenceFixture,
  waiting,
  occupancy,
} from "./accountSeatFenceFixtures";

beforeAll(initializeFenceDatabase);

function afterBatch(db: D1Database, release: () => Promise<void>, insertIndex = 2): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch")
        return async <T>(statements: D1PreparedStatement[]) => {
          const results = await target.batch<T>(statements);
          expect(results[insertIndex].meta.changes).toBe(0);
          await release();
          return results;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

for (const [label, db] of fenceDatabases) {
  for (const operation of ["enqueue", "joinWait", "restore"] as const) {
    for (const blocker of ["seat", "waiting"] as const) {
      const reason =
        operation !== "joinWait"
          ? blocker === "seat"
            ? "account_seated"
            : "matchmaking_waiting"
          : "account_busy";
      test(`${label}: ${operation}はbatch後に${blocker}が解放されても${reason}を返します`, async () => {
        const f = await fenceFixture(db);
        const otherQueue = operation !== "joinWait" ? "matchmaking" : "tournament";
        if (blocker === "seat") await f.seat();
        else await waiting(f, otherQueue);
        const table = blocker === "seat" ? "account_room_seats" : `${otherQueue}_wait_reservations`;
        // batch後に競合を解放し、判定はbatch内で取得した理由を使うことを確かめます。
        const interleaved = afterBatch(
          db,
          async () => {
            await db.prepare(`DELETE FROM ${table} WHERE account_id=?`).bind(f.id).run();
          },
          operation === "restore" ? 0 : 2,
        );
        const player = f.player;
        const result =
          operation === "enqueue"
            ? new D1TournamentQueueStore(interleaved).enqueue(player, f.key)
            : operation === "restore"
              ? new D1TournamentQueueStore(interleaved).restore(player, f.key)
              : joinWait(interleaved, undefined, player, "fence-test", "retired");

        await expect(result).rejects.toThrow(reason);
        expect(await occupancy(f)).toEqual([]);
      });
    }
  }
}

for (const [label, db] of fenceDatabases) {
  for (const blocker of ["seat", "waiting"] as const) {
    test(`${label}: レート戦のjoinWaitはbatch後に${blocker}が解放されても保存待ちと取り違えません`, async () => {
      const f = await fenceFixture(db);
      if (blocker === "seat") await f.seat();
      else await waiting(f, "tournament");
      const table = blocker === "seat" ? "account_room_seats" : "tournament_wait_reservations";
      const interleaved = afterBatch(db, async () => {
        await db.prepare(`DELETE FROM ${table} WHERE account_id=?`).bind(f.id).run();
      });

      await expect(
        joinWait(
          interleaved,
          ratedMatchmakingPolicy("four-reversi"),
          f.player,
          "rated-test",
          "retired",
        ),
      ).rejects.toThrow("account_busy");
      expect(await occupancy(f)).toEqual([]);
    });
  }
  test(`${label}: レートの保存待ちがbatch後に解放されても挿入0件は保存待ちとして返します`, async () => {
    const f = await fenceFixture(db);
    await db
      .prepare(
        "INSERT INTO skill_rating_pending(game,account_id,match_id) VALUES('four-shogi',?,?)",
      )
      .bind(f.id, crypto.randomUUID())
      .run();
    const clear = () =>
      db.prepare("DELETE FROM skill_rating_pending WHERE account_id=?").bind(f.id).run();
    const interleaved = afterBatch(db, async () => {
      await clear();
    });
    try {
      expect(
        await joinWait(
          interleaved,
          ratedMatchmakingPolicy("four-reversi"),
          f.player,
          "rated-test",
          "retired",
        ),
      ).toEqual({ inserted: false, latest: undefined });
      expect(await occupancy(f)).toEqual([]);
    } finally {
      await clear();
    }
  });
}
