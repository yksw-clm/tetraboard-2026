import { isReversiRoom, isShogiRoom } from "@tetraboard/protocol";
import { evictDurableObject, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test } from "vitest";
import { isFourShogiRoom, fourShogiRoomSchema, type GameId } from "@tetraboard/protocol";
import { getLegalActions } from "@tetraboard/four-shogi";
import { ShogiStore } from "../src/adapters/room/games/four-shogi/store";
import {
  registerRoomDeadlineBoundaryFixtures,
  start,
  type SavedCpuJob,
  snapshot,
  roomSchema,
} from "./roomDeadlineBoundaryFixtures";

registerRoomDeadlineBoundaryFixtures();

test.each(["一致", "期限切れ", "別局", "revision違い", "手番違い"])(
  "将棋: DO再生成後の保存済みCPU選択を再検証する (%s)",
  async (condition) => {
    const prepared = await start("four-shogi", true);
    await runInDurableObject(prepared.stub, async (instance, state) => {
      const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      const cpu = room.players.find((player) => player.kind === "cpu");
      if (!cpu) throw new Error("Missing CPU");
      const store = new ShogiStore(state.storage.sql);
      const game = store.loadState(room.roundId, room.game);
      if (game.status !== "playing") throw new Error("Not playing");
      const next = { ...game, turn: cpu.side };
      state.storage.kv.put(
        "room",
        fourShogiRoomSchema.parse({
          ...room,
          game: store.saveState(room.roundId, next),
          legalActions: getLegalActions(next),
          clock: {
            ...room.clock,
            turnStartedAt: Date.now() - 3_000,
            turnExpiresAt: Date.now() + 300_000,
          },
        }),
      );
      await instance.alarm();
      const job = state.storage.kv.get<SavedCpuJob>("shogi-cpu-job");
      if (!job) throw new Error("No saved selection");
      state.storage.kv.put("shogi-cpu-job", {
        ...job,
        applyAt: Date.now() - 1,
        roundId: condition === "別局" ? crypto.randomUUID() : job.roundId,
        positionRevision:
          condition === "revision違い" ? job.positionRevision + 1 : job.positionRevision,
        side: condition === "手番違い" ? room.players[0].side : job.side,
      });
      if (condition === "期限切れ") {
        const selected = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
        state.storage.kv.put(
          "room",
          fourShogiRoomSchema.parse({
            ...selected,
            clock: { ...selected.clock, turnExpiresAt: Date.now() - 1 },
          }),
        );
      }
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(prepared.stub, { webSockets: "hibernate" });
    const applied = await runInDurableObject(prepared.stub, async (instance, state) => {
      await instance.alarm();
      expect(state.storage.kv.get("shogi-cpu-job")).toBeUndefined();
      const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      // 次の選択を作る自動Alarmを止め、再実行でこの選択を二重適用しないことを検査。
      state.storage.kv.put(
        "room",
        fourShogiRoomSchema.parse({
          ...room,
          clock: { ...room.clock, turnStartedAt: Date.now() + 60_000 },
        }),
      );
      await state.storage.setAlarm(Date.now() + 60_000);
      return room;
    });
    const result = fourShogiRoomSchema.parse((await snapshot(prepared.room.id)).room);
    if (result.status !== "playing") throw new Error("Ended early");
    expect(result.game).toEqual(applied.game);
    expect(result.game.moveNumber).toBe(condition === "一致" ? 1 : 0);
    expect(result.positionRevision).toBe(condition === "一致" || condition === "期限切れ" ? 1 : 0);
    if (condition === "期限切れ")
      expect(result.game.eliminations).toMatchObject([{ reason: "timeout" }]);
    await evictDurableObject(prepared.stub, { webSockets: "hibernate" });
    expect(await runDurableObjectAlarm(prepared.stub)).toBe(true);
    expect(
      fourShogiRoomSchema.parse((await snapshot(prepared.room.id)).room).game?.moveNumber,
    ).toBe(result.game.moveNumber);
  },
);

for (const game of ["four-reversi", "four-shogi"] satisfies GameId[]) {
  test(`${game}: 通常GETでのCPU進行はゲーム別の手順を維持する`, async () => {
    const prepared = await start(game, true);
    const before = await runInDurableObject(prepared.stub, async (_instance, state) => {
      const room = roomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      const cpu = room.players.find((player) => player.kind === "cpu");
      if (!cpu) throw new Error("Missing CPU");
      let next;
      if (isReversiRoom(room) || isShogiRoom(room)) throw Error("Expected existing game fixture");
      if (isFourShogiRoom(room)) {
        if (!("side" in cpu)) throw new Error("Wrong CPU");
        const store = new ShogiStore(state.storage.sql);
        const full = store.loadState(room.roundId, room.game);
        if (full.status !== "playing") throw new Error("Not playing");
        const position = { ...full, turn: cpu.side };
        next = roomSchema.parse({
          ...room,
          game: store.saveState(room.roundId, position),
          legalActions: getLegalActions(position),
        });
      } else {
        if (!("color" in cpu)) throw new Error("Wrong CPU");
        next = roomSchema.parse({ ...room, game: { ...room.game, turn: cpu.color } });
      }
      const saved = roomSchema.parse({
        ...next,
        clock: {
          ...room.clock,
          turnStartedAt: Date.now() - 3_000,
          turnExpiresAt: Date.now() + 300_000,
        },
      });
      state.storage.kv.put("room", saved);
      await state.storage.setAlarm(Date.now() + 60_000);
      return saved;
    });
    const response = await snapshot(prepared.room.id);
    expect(response.room.game).toEqual(before.game);
    await runInDurableObject(prepared.stub, (_instance, state) => {
      const key = game === "four-shogi" ? "shogi-cpu-job" : "four-reversi-cpu-job";
      expect(state.storage.kv.get(key)).toBeUndefined();
    });
  });
}
