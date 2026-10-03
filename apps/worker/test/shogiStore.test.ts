import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  applyAction,
  chooseCpuAction,
  createInitialState,
  getLegalActions,
} from "@tetraboard/four-shogi";
import { ShogiStore } from "../src/rooms/shogiStore";

test("履歴が増えても一手のSQLite読み取り行数は増えない", async () => {
  const measurements: { moveReads: number; cpuReads: number; cpuWrites: number }[] = [];
  for (const historySize of [1_000, 10_000]) {
    const reads = await runInDurableObject(
      env.GAME_ROOM.getByName(crypto.randomUUID()),
      (_instance, ctx) => {
        const sql = ctx.storage.sql;
        const initial = createInitialState({
          mode: "singles",
          players: { south: "s", west: "w", north: "n", east: "e" },
        });
        const store = new ShogiStore(sql);
        const core = store.saveState("round", initial);
        const next = applyAction(initial, "south", getLegalActions(initial)[0]);
        if (!next.ok) throw new Error(next.reason);
        const nextKey = Object.keys(next.state.repetitions).find(
          (key) => !(key in initial.repetitions),
        )!;
        sql.exec("INSERT INTO shogi_repetitions VALUES (?, ?, ?)", "round", nextKey, 1);
        sql.exec(
          "WITH RECURSIVE positions(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM positions WHERE n < ?) INSERT INTO shogi_repetitions SELECT ?, 'unused-' || n, 1 FROM positions",
          historySize,
          "round",
        );
        const cursors: { readonly rowsRead: number; readonly rowsWritten: number }[] = [];
        const measuredSql = new Proxy(sql, {
          get(target, key) {
            if (key !== "exec") return Reflect.get(target, key, target);
            return (query: string, ...bindings: unknown[]) => {
              const cursor = target.exec(query, ...bindings);
              cursors.push(cursor);
              return cursor;
            };
          },
        });
        const measured = new ShogiStore(measuredSql);
        const cpu = measured.loadTransition("round", core);
        expect(chooseCpuAction(cpu.state, 2, () => 0.25, cpu.repetitionLookup)).not.toBeNull();
        const cpuReads = cursors.reduce((total, cursor) => total + cursor.rowsRead, 0);
        const cpuWrites = cursors.reduce((total, cursor) => total + cursor.rowsWritten, 0);
        cursors.length = 0;
        const { state, repetitionLookup } = measured.loadTransition("round", core);
        const result = applyAction(state, state.turn!, getLegalActions(state)[0], repetitionLookup);
        if (!result.ok) throw new Error(result.reason);
        measured.saveState("round", result.state);
        const moveReads = cursors.reduce((total, cursor) => total + cursor.rowsRead, 0);
        expect(
          sql
            .exec<{ occurrences: number }>(
              "SELECT occurrences FROM shogi_repetitions WHERE round_id = ? AND position_key = ?",
              "round",
              nextKey,
            )
            .one().occurrences,
        ).toBe(2);
        return { moveReads, cpuReads, cpuWrites };
      },
    );
    measurements.push(reads);
  }
  expect(measurements[0].moveReads).toBeGreaterThan(0);
  expect(measurements[0].moveReads).toBeLessThanOrEqual(10);
  expect(measurements[0].cpuWrites).toBe(0);
  expect(measurements[1]).toEqual(measurements[0]);
});

test("既存行からの再生成・ロールバック・局ID分離で回数を維持する", async () => {
  await runInDurableObject(env.GAME_ROOM.getByName(crypto.randomUUID()), (_instance, ctx) => {
    const sql = ctx.storage.sql;
    const base = createInitialState({
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
    });
    const store = new ShogiStore(sql);
    const core = store.saveState("old-round", base);
    const action = getLegalActions(base)[0];
    const next = applyAction(base, "south", action);
    if (!next.ok) throw new Error(next.reason);
    const key = Object.keys(next.state.repetitions).find((key) => !(key in base.repetitions))!;
    sql.exec("INSERT INTO shogi_repetitions VALUES (?, ?, ?)", "old-round", key, 2);
    const attempt = () => {
      const transition = new ShogiStore(sql).loadTransition("old-round", core);
      const result = applyAction(transition.state, "south", action, transition.repetitionLookup);
      if (!result.ok) throw new Error(result.reason);
      return result.state;
    };
    expect(() =>
      ctx.storage.transactionSync(() => {
        store.saveState("old-round", attempt());
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(attempt().repetitions[key]).toBe(3);
    const newCore = ctx.storage.transactionSync(() => store.saveState("old-round", attempt()));
    const restored = new ShogiStore(sql).loadState("old-round", newCore);
    expect(restored.repetitions[key]).toBe(3);
    const reloaded = new ShogiStore(sql).loadTransition("old-round", newCore);
    expect(reloaded.repetitionLookup(key)).toBe(3);
    store.saveState("new-round", base);
    expect(new ShogiStore(sql).loadTransition("new-round", core).repetitionLookup(key)).toBe(0);
  });
});
