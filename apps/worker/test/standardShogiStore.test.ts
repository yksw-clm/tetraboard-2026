import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  createInitialState,
  applyAction,
  getLegalActions,
  chooseCpuAction,
} from "@tetraboard/shogi";
import { StandardShogiStore } from "../src/rooms/standardShogiStore";
test("通常将棋の履歴が増えても着手・CPUが必要な局面だけを読み、探索では保存しない", async () => {
  const measurements = [];
  for (const size of [1000, 10000])
    measurements.push(
      await runInDurableObject(env.GAME_ROOM.getByName(crypto.randomUUID()), (_instance, ctx) => {
        const sql = ctx.storage.sql;
        const store = new StandardShogiStore(sql);
        const initial = createInitialState({ players: { south: "s", north: "n" } });
        const core = store.saveState("round", initial);
        sql.exec(
          "WITH RECURSIVE positions(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM positions WHERE n < ?) INSERT INTO standard_shogi_repetitions SELECT ?, 'unused-' || n, '{}' FROM positions",
          size,
          "round",
        );
        const cursors: { readonly rowsRead: number; readonly rowsWritten: number }[] = [];
        const measured = new StandardShogiStore(
          new Proxy(sql, {
            get(target, key) {
              if (key !== "exec") return Reflect.get(target, key, target);
              return (query: string, ...bindings: unknown[]) => {
                const cursor = target.exec(query, ...bindings);
                cursors.push(cursor);
                return cursor;
              };
            },
          }),
        );
        const cpu = measured.loadTransition("round", core);
        expect(chooseCpuAction(cpu.state, 2, () => 0.5, cpu.repetitionLookup, 64)).not.toBeNull();
        const cpuReads = cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
        expect(cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(0);
        cursors.length = 0;
        const transition = measured.loadTransition("round", core);
        const next = applyAction(
          transition.state,
          "south",
          getLegalActions(transition.state)[0],
          transition.repetitionLookup,
        );
        if (!next.ok) throw Error(next.reason);
        const publicState = measured.saveState("round", next.state);
        expect(publicState).not.toHaveProperty("repetitions");
        const moveReads = cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
        expect(moveReads).toBeLessThanOrEqual(10);
        expect(
          new StandardShogiStore(sql)
            .loadTransition("other-round", publicState)
            .repetitionLookup(Object.keys(next.state.repetitions)[0]),
        ).toBeUndefined();
        return { cpuReads, moveReads };
      }),
    );
  expect(measurements[1]).toEqual(measurements[0]);
});
