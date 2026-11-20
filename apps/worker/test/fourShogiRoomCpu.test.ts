import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import {
  applyAction,
  getLegalActions,
  getActionAvailability,
  sides,
  type Side,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import { fourShogiRoomSchema } from "@tetraboard/protocol";
import { ShogiStore } from "../src/adapters/room/games/four-shogi/store";
import { tacticalCases } from "../../../packages/four-shogi/bench/tactics";
import { shogiMatchStartKey, type ActiveShogiMatch } from "../src/adapters/record/shogiMatchStore";
import { registerFourShogiRoomFixtures, create, connect, get } from "./fourShogiRoomFixtures";

registerFourShogiRoomFixtures();

test("CPU Lv2は選択を保存した次のAlarmで期限を照合し、期限切れの選択を着手しない", async () => {
  const created = await create(true);
  const client = await connect(created.room.id, created.membership.token);
  client.send({ type: "room.game.start" });
  const started = await client.room((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Not playing");
  // A full engine state at a CPU turn is a persisted storage boundary fixture.
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), async (instance, state) => {
    const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    const cpu = room.players.find((player) => player.kind === "cpu")!;
    const store = new ShogiStore(state.storage.sql);
    const game = store.loadState(room.roundId, room.game);
    if (game.status !== "playing") throw new Error("Not playing");
    const at = Date.now();
    const cpuState = { ...game, turn: cpu.side } as FourShogiState;
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...room,
        players: room.players.map((player) =>
          player.kind === "cpu" ? { ...player, level: 2 } : player,
        ),
        game: store.saveState(room.roundId, cpuState),
        legalActions: getLegalActions(cpuState),
        clock: { ...room.clock, turnStartedAt: at - 3000, turnExpiresAt: at + 60000 },
      }),
    );
    await instance.alarm();
    const job = state.storage.kv.get<{ side: Side; applyAt: number }>("shogi-cpu-job");
    expect(job).toMatchObject({ roundId: room.roundId, positionRevision: 0, side: cpu.side });
    const selected = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    expect(selected.game?.moveNumber).toBe(0);
    expect(state.storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey)?.knockouts).toEqual({
      south: 0,
      west: 0,
      north: 0,
      east: 0,
    });
    state.storage.kv.put("shogi-cpu-job", { ...job, applyAt: Date.now() + 60000 });
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...selected,
        clock: { ...selected.clock, turnExpiresAt: Date.now() - 1 },
      }),
    );
    await state.storage.setAlarm(Date.now() + 60000);
  });
  await runDurableObjectAlarm(env.GAME_ROOM.getByName(created.room.id));
  const room = await get(created.room.id);
  if (room.status !== "playing") throw new Error("Not playing");
  expect(room.game.moveNumber).toBe(0);
  expect(room.game.eliminations[0]).toMatchObject({ reason: "timeout" });
  expect(room.positionRevision).toBe(1);
});

test.each([
  { mode: "singles" as const, restricted: false },
  { mode: "singles" as const, restricted: true },
  { mode: "doubles" as const, restricted: false },
  { mode: "doubles" as const, restricted: true },
])(
  "CPU Lv2の探索は履歴を保存せず、安全な飛車取りだけを次のAlarmで確定する $mode/$restricted",
  async ({ mode, restricted }) => {
    const created = await create(true, mode);
    const client = await connect(created.room.id, created.membership.token);
    client.send({ type: "room.game.start" });
    await client.room((room) => room.status === "playing");
    await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), async (instance, ctx) => {
      const room = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      const cpu = room.players.find((player) => player.kind === "cpu")!;
      const fixture = tacticalCases().find(
        (entry) => entry.id === `free-rook-${restricted}-${cpu.side}`,
      )!.state;
      const game = { ...fixture, mode, players: room.game.players };
      const store = new ShogiStore(ctx.storage.sql);
      const at = Date.now();
      const prepared = fourShogiRoomSchema.parse({
        ...room,
        players: room.players.map((player) =>
          player.kind === "cpu" ? { ...player, level: 2 } : player,
        ),
        settings: { ...room.settings, threePlayerAttackProhibited: restricted },
        game: store.saveState(room.roundId, game),
        ...getActionAvailability(game),
        clock: { ...room.clock, turnStartedAt: at - 3000, turnExpiresAt: at + 60000 },
      });
      ctx.storage.kv.put("room", prepared);
      ctx.storage.kv.delete("shogi-cpu-job");
      const historyBefore = ctx.storage.sql
        .exec("SELECT * FROM shogi_repetitions ORDER BY round_id, position_key")
        .toArray();
      const eventsBefore = store.eventCount(room.roundId);
      await instance.alarm();
      const selected = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
      const job = ctx.storage.kv.get<{
        action: import("@tetraboard/four-shogi").FourShogiAction;
        applyAt: number;
      }>("shogi-cpu-job")!;
      expect(selected.game).toEqual(prepared.game);
      expect(selected.positionRevision).toBe(prepared.positionRevision);
      expect(store.eventCount(room.roundId)).toBe(eventsBefore);
      expect(
        ctx.storage.sql
          .exec("SELECT * FROM shogi_repetitions ORDER BY round_id, position_key")
          .toArray(),
      ).toEqual(historyBefore);
      const preview = applyAction(game, cpu.side, job.action);
      expect(preview.ok && preview.captured?.kind).toBe("rook");
      ctx.storage.kv.put("shogi-cpu-job", { ...job, applyAt: Date.now() - 1 });
      await instance.alarm();
      const moved = fourShogiRoomSchema.parse(ctx.storage.kv.get("room"));
      expect(moved.game?.hands[cpu.side].rook).toBe(1);
      expect(moved.game?.moveNumber).toBe(1);
      expect(moved.positionRevision).toBe(prepared.positionRevision + 1);
      expect(moved.game).not.toHaveProperty("repetitions");
      expect(moved.game).not.toHaveProperty("search");
      expect(store.eventCount(room.roundId)).toBe(eventsBefore + 1);
      await ctx.storage.setAlarm(Date.now() + 60000);
    });
  },
);

test("CPUの保存した合法手を次のAlarmで一度だけ適用し、局ID・revision・手番が違う選択を破棄する", async () => {
  const created = await create(true);
  const client = await connect(created.room.id, created.membership.token);
  client.send({ type: "room.game.start" });
  await client.room((room) => room.status === "playing");
  const cpu = await runInDurableObject(
    env.GAME_ROOM.getByName(created.room.id),
    async (instance, state) => {
      const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
      if (room.status !== "playing") throw new Error("Not playing");
      const cpu = room.players.find((player) => player.kind === "cpu")!;
      const store = new ShogiStore(state.storage.sql);
      const core = store.loadState(room.roundId, room.game);
      const game = { ...core, status: "playing" as const, result: null, turn: cpu.side };
      const at = Date.now();
      state.storage.kv.put(
        "room",
        fourShogiRoomSchema.parse({
          ...room,
          game: store.saveState(room.roundId, game),
          legalActions: getLegalActions(game),
          clock: { ...room.clock, turnStartedAt: at - 3000, turnExpiresAt: at + 60000 },
        }),
      );
      await instance.alarm();
      const job = state.storage.kv.get<Record<string, unknown>>("shogi-cpu-job")!;
      expect(job).toBeTruthy();
      state.storage.kv.put("shogi-cpu-job", { ...job, applyAt: Date.now() + 60000 });
      await state.storage.setAlarm(Date.now() + 60000);
      return { side: cpu.side, job };
    },
  );
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), async (instance, state) => {
    state.storage.kv.put("shogi-cpu-job", { ...cpu.job, applyAt: Date.now() - 1 });
    await instance.alarm();
    const moved = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    expect(moved.game?.moveNumber).toBe(1);
    expect(moved.positionRevision).toBe(1);
    expect(moved.game?.lastMove?.side).toBe(cpu.side);
    expect(state.storage.kv.get("shogi-cpu-job")).toBeUndefined();
    await state.storage.setAlarm(Date.now() + 60000);
  });
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), async (instance, state) => {
    const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    const cpuPlayer = room.players.find((player) => player.kind === "cpu")!;
    const store = new ShogiStore(state.storage.sql);
    const game = {
      ...store.loadState(room.roundId, room.game),
      status: "playing" as const,
      result: null,
      turn: cpuPlayer.side,
    };
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...room,
        game: store.saveState(room.roundId, game),
        legalActions: getLegalActions(game),
        clock: {
          ...room.clock,
          turnStartedAt: Date.now() - 3000,
          turnExpiresAt: Date.now() + 60000,
        },
      }),
    );
    for (const outdated of [
      { positionRevision: 0 },
      { roundId: crypto.randomUUID() },
      { side: sides.find((side) => side !== cpuPlayer.side)! },
    ]) {
      state.storage.kv.put("shogi-cpu-job", {
        ...cpu.job,
        roundId: room.roundId,
        positionRevision: room.positionRevision,
        side: cpuPlayer.side,
        applyAt: Date.now() - 1,
        ...outdated,
      });
      await instance.alarm();
      expect(fourShogiRoomSchema.parse(state.storage.kv.get("room")).game?.moveNumber).toBe(1);
      expect(state.storage.kv.get("shogi-cpu-job")).toBeUndefined();
    }
    await state.storage.setAlarm(Date.now() + 60000);
  });
});

test.each([
  { mainTimeMs: 0, byoyomiMs: 10_000 },
  { mainTimeMs: 60_000, byoyomiMs: 0 },
] as const)("将棋CPUの着手・再戦・保存履歴は $mainTimeMs + $byoyomiMs を使う", async (control) => {
  const created = await create(true, "singles", control);
  const client = await connect(created.room.id, created.membership.token);
  client.send({ type: "room.game.start" });
  let room = await client.room((room) => room.status === "playing");
  if (room.status !== "playing") throw new Error("Not playing");
  const roundId = room.roundId;
  const openingTurn = room.game.turn;
  if (room.players.find((p) => p.side === openingTurn)?.kind === "human") {
    client.send({
      type: "room.game.action",
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      action: room.legalActions[0],
    });
    room = await client.room((room) => room.status === "playing" && room.positionRevision > 0);
    if (room.status !== "playing") throw new Error("Not playing");
  }
  const moveNumber = room.game.moveNumber;
  const cpuTurn = room.game.turn;
  const cpu = room.players.find((p) => p.side === cpuTurn)!;
  expect(cpu.kind).toBe("cpu");
  const moved = await client.room(
    (room) => room.status === "playing" && room.game.moveNumber > moveNumber,
  );
  if (moved.status !== "playing") throw new Error("Not playing");
  expect(moved.clock.turnExpiresAt - moved.clock.turnStartedAt).toBe(
    moved.clock.remainingMainMs[moved.game.turn] + control.byoyomiMs,
  );
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), async (instance, state) => {
    const current = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (current.status !== "playing") throw new Error("Not playing");
    // Alarmの遅延による全員の時間切れで、CPUの追加着手なしに終局させます。
    state.storage.kv.put("room", {
      ...current,
      clock: {
        ...current.clock,
        turnStartedAt: Date.now() - 300_000,
        turnExpiresAt: Date.now() - 200_000,
      },
    });
    await instance.alarm();
  });
  const waiting = await client.room((room) => room.status === "waiting");
  expect(waiting.settings.timeControl).toEqual(control);
  const lastRound = waiting.lastRound;
  client.send({
    type: "room.time-control.set",
    timeControl: { mainTimeMs: 300_000, byoyomiMs: 30_000 },
  });
  const changed = await client.room((room) => room.settings.timeControl.mainTimeMs === 300_000);
  expect(changed.lastRound).toEqual(lastRound);
  expect(changed.players.filter((p) => p.kind === "cpu").every((p) => p.ready)).toBe(true);
  await vi.waitFor(async () => {
    const row = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
      .bind(roundId)
      .first<{ record_json: string }>();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.record_json).settings.timeControl).toEqual(control);
  });
});
