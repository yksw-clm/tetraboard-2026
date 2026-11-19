import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  applyAction,
  createInitialState,
  eliminateSide,
  setDrawProposal,
  getLegalActions,
  sides,
  type FourShogiState,
} from "@tetraboard/four-shogi";
import {
  getFourShogiReplayContract,
  fourShogiRoomSchema,
  type FourShogiRoom,
} from "@tetraboard/protocol";
import { ShogiStore } from "../src/rooms/shogiStore";
import { readShogiMatchRecord } from "../src/adapters/record/shogiMatchStore";
import {
  registerFourShogiRoomFixtures,
  start,
  sideIndex,
  get,
  connect,
  request,
  create,
} from "./fourShogiRoomFixtures";

registerFourShogiRoomFixtures();

async function drawCurrent(
  prepared: Awaited<ReturnType<typeof start>>,
  room: Extract<FourShogiRoom, { status: "playing" }>,
  proposed: boolean,
) {
  prepared.clients[sideIndex(prepared, room.game.turn)].send({
    type: "room.game.draw.set",
    proposed,
    roundId: room.roundId,
    positionRevision: room.positionRevision,
  });
  return prepared.clients[0].room(
    (next) => next.status === "waiting" || next.positionRevision > room.positionRevision,
  );
}

test("引分提案・取消を全接続へ保存・配信し、時計と手番を維持して再接続で復元する", async () => {
  const prepared = await start();
  const before = prepared.room;
  const offered = await drawCurrent(prepared, before, true);
  if (offered.status !== "playing") throw new Error("Unexpected finish");
  expect(offered.game).toEqual({ ...before.game, drawProposals: [before.game.turn] });
  expect(offered.clock).toEqual(before.clock);
  expect((await get(prepared.id)).game).toEqual(offered.game);
  for (const client of prepared.clients.slice(1)) {
    const snapshot = await client.room(
      (room) => room.positionRevision === offered.positionRevision,
    );
    expect(snapshot.game).toEqual(offered.game);
  }
  const observer = await connect(prepared.id);
  expect(
    (await observer.room((room) => room.positionRevision === offered.positionRevision)).game,
  ).toEqual(offered.game);
  const reconnected = await connect(
    prepared.id,
    prepared.memberships[sideIndex(prepared, before.game.turn)].token,
  );
  reconnected.send({
    type: "room.game.draw.set",
    proposed: true,
    roundId: offered.roundId,
    positionRevision: offered.positionRevision,
  });
  expect(
    (await reconnected.room((room) => room.positionRevision === offered.positionRevision)).clock,
  ).toEqual(before.clock);
  const cancelled = await drawCurrent(prepared, offered, false);
  expect(cancelled.game?.drawProposals).toEqual([]);
  expect(cancelled.clock).toEqual(before.clock);
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
    const store = new ShogiStore(state.storage.sql);
    expect(store.replayEvents(before.roundId, 0)).toEqual([
      { type: "drawProposal", side: before.game.turn, proposed: true },
      { type: "drawProposal", side: before.game.turn, proposed: false },
    ]);
  });
});

test("引分操作は本人・手番・局ID・revision・期限を検証する", async () => {
  const prepared = await start();
  const room = prepared.room;
  const command = {
    type: "room.game.draw.set" as const,
    proposed: true,
    roundId: room.roundId,
    positionRevision: room.positionRevision,
  };
  const observer = await connect(prepared.id);
  observer.send(command);
  expect(await observer.error()).toBe("unauthorized");
  const other =
    prepared.clients[
      sideIndex(
        prepared,
        sides.find((side) => side !== room.game.turn)!,
      )
    ];
  other.send(command);
  expect(await other.error()).toBe("not_your_turn");
  const self = prepared.clients[sideIndex(prepared, room.game.turn)];
  self.send({ ...command, roundId: crypto.randomUUID() });
  expect(await self.error()).toBe("stale_position");
  self.send({ ...command, positionRevision: room.positionRevision + 1 });
  expect(await self.error()).toBe("stale_position");
  expect((await get(prepared.id)).game?.drawProposals).toEqual([]);
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
    state.storage.kv.put("room", {
      ...room,
      clock: { ...room.clock, turnExpiresAt: Date.now() - 1 },
    });
  });
  self.send(command);
  expect(await self.error()).toBe("stale_position");
  expect((await get(prepared.id)).game?.drawProposals).toEqual([]);
});

for (const mode of ["singles", "doubles"] as const) {
  test(`${mode}: 4人の提案で終局し、イベント棋譜・恒久記録・再戦へ接続する`, async () => {
    const prepared = await start(mode);
    let room: FourShogiRoom = prepared.room;
    for (let index = 0; index < 4; index++) {
      if (room.status !== "playing") throw new Error("Finished too early");
      room = await drawCurrent(prepared, room, true);
      if (index < 3) {
        if (room.status !== "playing") throw new Error("Finished too early");
        const before = room;
        prepared.clients[sideIndex(prepared, room.game.turn)].send({
          type: "room.game.action",
          action: room.legalActions[0],
          roundId: room.roundId,
          positionRevision: room.positionRevision,
        });
        room = await prepared.clients[0].room(
          (next) => next.positionRevision > before.positionRevision,
        );
      }
    }
    expect(room.status).toBe("waiting");
    expect(room.lastRound?.game.result.reason).toBe("agreement");
    expect(room.lastRound?.game.moveNumber).toBe(3);
    expect(room.lastRound?.eventCount).toBe(7);
    const response = await request(
      `/rooms/${prepared.id}/rounds/${prepared.room.roundId}/replay?instanceId=${prepared.room.instanceId}`,
    );
    const page = getFourShogiReplayContract.response.parse(await response.json());
    let replay = createInitialState(page.initial);
    for (const { event } of page.events) {
      const result =
        event.type === "action"
          ? applyAction(replay, event.side, event.action)
          : event.type === "eliminate"
            ? eliminateSide(replay, event.side, event.reason)
            : setDrawProposal(replay, event.side, event.proposed);
      if (!result.ok) throw new Error("Invalid replay event");
      replay = result.state;
    }
    const { repetitions: _repetitions, ...core } = replay;
    expect(core).toEqual(room.lastRound?.game);
    await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), async (instance) => {
      await instance.alarm();
    });
    const saved = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
      .bind(prepared.room.roundId)
      .first<{ record_json: string }>();
    expect(saved).not.toBeNull();
    const record = readShogiMatchRecord(saved!.record_json);
    expect(record?.game.result.reason).toBe("agreement");
    if (room.status !== "waiting") throw new Error("Expected waiting room");
    for (const client of prepared.clients) client.send({ type: "room.ready.set", ready: true });
    await prepared.clients[0].room((next) => next.players.every((player) => player.ready));
    prepared.clients[0].send({ type: "room.game.start" });
    const restarted = await prepared.clients[0].room((next) => next.status === "playing");
    expect(restarted.game?.drawProposals).toEqual([]);
    expect(restarted.roundId).not.toBe(prepared.room.roundId);
  });
}

test("CPUは手番で人間全員の提案・取消に合わせ、時計を維持し、古い思考結果を破棄する", async () => {
  const created = await create(true);
  const client = await connect(created.room.id, created.membership.token);
  client.send({ type: "room.game.start" });
  await client.room((room) => room.status === "playing");
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), async (instance, state) => {
    let room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Not playing");
    const human = room.players.find((player) => player.kind === "human")!;
    const cpu = room.players.find((player) => player.kind === "cpu")!;
    const store = new ShogiStore(state.storage.sql);
    const core = store.loadState(room.roundId, room.game);
    const game: FourShogiState = {
      ...core,
      status: "playing",
      turn: cpu.side,
      result: null,
      drawProposals: [human.side],
    };
    const at = Date.now();
    const clock = { ...room.clock, turnStartedAt: at - 3000, turnExpiresAt: at + 60000 };
    state.storage.kv.put(
      "room",
      fourShogiRoomSchema.parse({
        ...room,
        game: store.saveState(room.roundId, game),
        clock,
        legalActions: getLegalActions(game),
      }),
    );
    state.storage.kv.put("shogi-cpu-job", {
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      side: cpu.side,
      action: getLegalActions(game)[0],
      applyAt: at - 1,
    });
    await instance.alarm();
    room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Unexpected finish");
    expect(room.game.drawProposals).toContain(cpu.side);
    expect(room.clock).toEqual(clock);
    expect(room.game.moveNumber).toBe(core.moveNumber);
    const job = state.storage.kv.get<{ positionRevision: number; applyAt: number }>(
      "shogi-cpu-job",
    )!;
    expect(job.positionRevision).toBe(room.positionRevision);
    const cancelledGame = {
      ...store.loadState(room.roundId, room.game),
      drawProposals: [cpu.side],
    };
    state.storage.kv.put("room", {
      ...room,
      game: store.saveState(room.roundId, cancelledGame),
      positionRevision: room.positionRevision + 1,
    });
    state.storage.kv.put("shogi-cpu-job", { ...job, applyAt: at - 1 });
    await instance.alarm();
    const cancelled = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
    expect(cancelled.game?.drawProposals).toEqual([]);
    expect(cancelled.game?.moveNumber).toBe(core.moveNumber);
    expect(cancelled.clock).toEqual(clock);
    await state.storage.setAlarm(Date.now() + 60000);
  });
});

for (const humanSurviving of [true, false]) {
  test(
    humanSurviving
      ? "最後のCPUの同意で引き分けて待機に戻る"
      : "脱落した人間が在室していてもCPUは新たな引分提案を行わない",
    async () => {
      const created = await create(true);
      const client = await connect(created.room.id, created.membership.token);
      client.send({ type: "room.game.start" });
      await client.room((room) => room.status === "playing");
      await runInDurableObject(
        env.GAME_ROOM.getByName(created.room.id),
        async (instance, state) => {
          const room = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
          if (room.status !== "playing") throw new Error("Not playing");
          const cpu = room.players.find((player) => player.kind === "cpu")!;
          const store = new ShogiStore(state.storage.sql);
          let core = store.loadState(room.roundId, room.game);
          if (core.status !== "playing") throw new Error("Not playing");
          const human = room.players.find((player) => player.kind === "human")!;
          if (!humanSurviving) {
            const result = eliminateSide({ ...core, turn: human.side }, human.side, "resigned");
            if (!result.ok) throw new Error("Could not eliminate human");
            core = result.state;
          }
          const game: FourShogiState = {
            ...core,
            status: "playing",
            result: null,
            turn: cpu.side,
            drawProposals: humanSurviving ? sides.filter((side) => side !== cpu.side) : [],
          };
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
          state.storage.kv.delete("shogi-cpu-job");
          await instance.alarm();
          const next = fourShogiRoomSchema.parse(state.storage.kv.get("room"));
          if (humanSurviving) {
            expect(next.status).toBe("waiting");
            expect(next.lastRound?.game.result.reason).toBe("agreement");
            expect(state.storage.kv.get("shogi-cpu-job")).toBeUndefined();
          } else {
            expect(next.status).toBe("playing");
            expect(next.game?.drawProposals).toEqual([]);
            expect(store.eventCount(room.roundId)).toBe(0);
            expect(state.storage.kv.get("shogi-cpu-job")).toBeTruthy();
          }
          await state.storage.setAlarm(Date.now() + 60000);
        },
      );
    },
  );
}

test("保存状態から復元した秒読み中も提案・取消で期限を延長しない", async () => {
  const prepared = await start();
  await runInDurableObject(env.GAME_ROOM.getByName(prepared.id), (_instance, state) => {
    const at = Date.now();
    state.storage.kv.put("room", {
      ...prepared.room,
      clock: {
        remainingMainMs: { south: 0, west: 0, north: 0, east: 0 },
        turnStartedAt: at - 3000,
        turnExpiresAt: at + 29000,
      },
    });
  });
  const restored = await get(prepared.id);
  if (restored.status !== "playing") throw new Error("Not playing");
  expect(restored.game.drawProposals).toEqual([]);
  const offered = await drawCurrent(prepared, restored, true);
  if (offered.status !== "playing") throw new Error("Unexpected finish");
  expect(offered.clock).toEqual(restored.clock);
  const cancelled = await drawCurrent(prepared, offered, false);
  expect(cancelled.clock).toEqual(restored.clock);
});
