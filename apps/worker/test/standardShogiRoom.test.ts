import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  isShogiRoom,
  publicShogiMatchDetailSchema,
  getShogiReplayContract,
  type ShogiRoom,
  shogiRoomSchema,
} from "@tetraboard/protocol";
import { getActionAvailability, getCheckState, type ShogiState } from "@tetraboard/shogi";
import { StandardShogiStore } from "../src/rooms/standardShogiStore";
import { enteringState, goldCycle } from "./standardShogiFixtures";
import { ShogiProgress, type ShogiCpuJob } from "../src/rooms/standardShogiProgress";
import { RoomBoundaryFixtures, boundaryRequest, boundaryJson } from "./roomBoundaryFixtures";
let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
afterEach(async () => {
  await fixtures.dispose();
});
function shogi(room: Awaited<ReturnType<RoomBoundaryFixtures["snapshot"]>>["room"]): ShogiRoom {
  if (!isShogiRoom(room)) throw new Error("Expected shogi");
  return room;
}
async function setup() {
  const entry = await fixtures.create({ game: "shogi", name: "先輩", quickPlay: false });
  const host = await fixtures.connect(entry);
  const joined = await fixtures.join(entry.room.id, "後輩");
  const guest = await fixtures.connect(joined);
  for (const [client, id] of [
    [host, entry.membership.playerId],
    [guest, joined.membership.playerId],
  ] as const) {
    client.send({ type: "room.ready.set", ready: true });
    await host.waitFor(
      "room.snapshot",
      (m) => m.room.players.find((p) => p.id === id)?.ready === true,
    );
  }
  host.send({ type: "room.game.start" });
  const room = shogi(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  if (room.status !== "playing") throw Error("Expected playing");
  const first = room.game.players.south === entry.membership.playerId ? host : guest;
  const second = first === host ? guest : host;
  return { entry, joined, host, guest, first, second, room };
}
test("通常将棋はモードなしの2席で3人目とモード設定を拒否する", async () => {
  const entry = await fixtures.create({ game: "shogi", name: "ホスト", quickPlay: false });
  const host = await fixtures.connect(entry);
  expect(entry.room.settings).not.toHaveProperty("mode");
  await fixtures.join(entry.room.id, "相手");
  expect(
    (await boundaryRequest(`/rooms/${entry.room.id}/players`, boundaryJson({ name: "3人目" })))
      .status,
  ).toBe(409);
  host.send({ type: "room.mode.set", mode: "doubles" });
  expect((await host.waitFor("room.error")).error).toBe("forbidden");
  for (const mode of ["singles", "doubles"])
    expect(
      (
        await boundaryRequest(
          "/rooms",
          boundaryJson({ game: "shogi", name: "不正", quickPlay: false, mode }),
        )
      ).status,
    ).toBe(400);
  const response = await boundaryRequest("/rooms?game=shogi");
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    rooms: { id: string; capacity: number; mode?: string }[];
  };
  const listed = data.rooms.find((r) => r.id === entry.room.id);
  expect(listed).toMatchObject({ capacity: 2 });
  expect(listed).not.toHaveProperty("mode");
});
test("通常将棋の着手・古い局面拒否・休止復帰・投了を記録し、棋譜と再戦を保持する", async () => {
  const { entry, host, guest, first, second, room } = await setup();
  expect(room.game.board.flat().filter(Boolean)).toHaveLength(40);
  const action = room.legalActions[0];
  const command = {
    type: "room.game.action" as const,
    roundId: room.roundId,
    positionRevision: 0,
    action,
  };
  first.send(command);
  const played = shogi(
    (
      await host.waitFor(
        "room.snapshot",
        (m) => isShogiRoom(m.room) && m.room.positionRevision === 1,
      )
    ).room,
  );
  expect(played.game?.moveNumber).toBe(1);
  first.send(command);
  expect((await first.waitFor("room.error")).error).toBe("stale_position");
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  await evictDurableObject(stub, { webSockets: "hibernate" });
  expect((await fixtures.snapshot(entry.room.id)).room).toEqual(played);
  first.send({ type: "room.game.resign" });
  expect((await first.waitFor("room.error")).error).toBe("not_your_turn");
  second.send({ type: "room.game.resign" });
  const ended = shogi(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "waiting")).room,
  );
  expect(ended.lastRound?.game.result).toEqual({ winner: "south", reason: "resigned" });
  expect(ended.players).toHaveLength(2);
  expect(ended.players.every((p) => !p.ready)).toBe(true);
  const last = ended.lastRound!;
  await fixtures.snapshot(entry.room.id);
  const replayResponse = await boundaryRequest(
    `${getShogiReplayContract.pathFor(entry.room.id, last.roundId)}?instanceId=${room.instanceId}`,
  );
  expect(replayResponse.status).toBe(200);
  const replay = getShogiReplayContract.response.parse(await replayResponse.json());
  expect(replay.events.map((e) => e.event.type)).toEqual(["action", "eliminate"]);
  const savedResponse = await boundaryRequest(`/matches/${last.roundId}`);
  expect(savedResponse.status).toBe(200);
  const saved = publicShogiMatchDetailSchema.parse(
    ((await savedResponse.json()) as { match: unknown }).match,
  );
  expect(saved.game).toEqual(last.game);
  expect(saved.settings).not.toHaveProperty("mode");
  const savedReplay = await boundaryRequest(`/matches/${last.roundId}/replay`);
  expect(savedReplay.status).toBe(200);
  host.send({ type: "room.ready.set", ready: true });
  guest.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (m) => m.room.players.every((p) => p.ready));
  host.send({ type: "room.game.start" });
  const next = shogi(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  expect(next.lastRound).toBeNull();
  if (next.status !== "playing") throw Error("Expected playing");
  expect(next.roundId).not.toBe(room.roundId);
  expect(next.game.drawProposals).toEqual([]);
  expect(next.game.moveNumber).toBe(0);
});

async function seedPosition(room: Extract<ShogiRoom, { status: "playing" }>, state: ShogiState) {
  const stub = env.GAME_ROOM.getByName(room.id);
  await runInDurableObject(stub, (_instance, context) => {
    const store = new StandardShogiStore(context.storage.sql);
    context.storage.kv.put(
      "room",
      shogiRoomSchema.parse({
        ...room,
        game: store.saveState(room.roundId, state),
        ...getActionAvailability(state),
        checkState: getCheckState(state),
      }),
    );
  });
  await evictDurableObject(stub, { webSockets: "hibernate" });
}
test("持将棋提案は入玉前を拒否し、手番外の提案・取消と復帰を保持し、時計を延長しない", async () => {
  const { room, first, second, host } = await setup();
  const draw = (revision: number, proposed: boolean) => ({
    type: "room.game.draw.set" as const,
    roundId: room.roundId,
    positionRevision: revision,
    proposed,
  });
  second.send(draw(0, true));
  expect((await second.waitFor("room.error")).error).toBe("invalid_request");
  await seedPosition(room, enteringState(room.game.players, 24));
  second.send(draw(0, true));
  const proposed = shogi(
    (
      await host.waitFor(
        "room.snapshot",
        (m) => isShogiRoom(m.room) && m.room.positionRevision === 1,
      )
    ).room,
  );
  expect(proposed.game?.drawProposals).toEqual(["north"]);
  expect(proposed.clock).toEqual(room.clock);
  const stub = env.GAME_ROOM.getByName(room.id);
  await evictDurableObject(stub, { webSockets: "hibernate" });
  expect(shogi((await fixtures.snapshot(room.id)).room).game?.drawProposals).toEqual(["north"]);
  second.send(draw(1, false));
  const cancelled = shogi(
    (
      await host.waitFor(
        "room.snapshot",
        (m) => isShogiRoom(m.room) && m.room.positionRevision === 2,
      )
    ).room,
  );
  expect(cancelled.game?.drawProposals).toEqual([]);
  expect(cancelled.clock).toEqual(room.clock);
  second.send(draw(2, true));
  await host.waitFor("room.snapshot", (m) => isShogiRoom(m.room) && m.room.positionRevision === 3);
  first.send(draw(3, true));
  const ended = shogi(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "waiting")).room,
  );
  expect(ended.lastRound?.game.result).toEqual({ winner: null, reason: "impasse" });
});
test("入玉宣言の古い局面・手番外を拒否し、条件不足の本人宣言だけ敗北にする", async () => {
  const { room, first, second, host } = await setup();
  const declaration = {
    type: "room.game.declare" as const,
    roundId: room.roundId,
    positionRevision: 0,
  };
  second.send(declaration);
  expect((await second.waitFor("room.error")).error).toBe("not_your_turn");
  first.send({ ...declaration, positionRevision: 1 });
  expect((await first.waitFor("room.error")).error).toBe("stale_position");
  expect((await fixtures.snapshot(room.id)).room.status).toBe("playing");
  first.send(declaration);
  const ended = shogi(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "waiting")).room,
  );
  expect(ended.lastRound?.game.result).toEqual({ winner: "north", reason: "invalid_declaration" });
});
test.each([24, 31])("%i点の入玉宣言をWebSocketから裁定する", async (points) => {
  const { room, first, host } = await setup();
  await seedPosition(room, enteringState(room.game.players, points));
  first.send({ type: "room.game.declare", roundId: room.roundId, positionRevision: 0 });
  const ended = shogi(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "waiting")).room,
  );
  expect(ended.lastRound?.game.result).toEqual({
    winner: points === 31 ? "south" : null,
    reason: "declaration",
  });
});
test("休止復帰を挟んだ千日手は4回目だけ終局し、局面履歴を配信に含めない", async () => {
  const { room, first, second, host } = await setup();
  let current: ShogiRoom = room;
  for (let n = 0; n < 12; n++) {
    (n % 2 === 0 ? first : second).send({
      type: "room.game.action",
      action: goldCycle[n % 4],
      roundId: room.roundId,
      positionRevision: n,
    });
    current = shogi(
      (
        await host.waitFor(
          "room.snapshot",
          (m) =>
            isShogiRoom(m.room) &&
            (n === 11 ? m.room.status === "waiting" : m.room.positionRevision === n + 1),
        )
      ).room,
    );
    expect(current.game ?? current.lastRound?.game).not.toHaveProperty("repetitions");
    if (n % 4 === 3)
      await evictDurableObject(env.GAME_ROOM.getByName(room.id), { webSockets: "hibernate" });
  }
  expect(current.lastRound?.game.result).toEqual({ winner: null, reason: "repetition" });
  expect(current.lastRound?.eventCount).toBe(12);
});
test("通常将棋は期限を先に裁定し、遅延Alarmと復帰でも終局保存を重複しない", async () => {
  const { room, first, host } = await setup();
  const stub = env.GAME_ROOM.getByName(room.id);
  await runInDurableObject(stub, (_instance, context) =>
    context.storage.kv.put("room", {
      ...room,
      clock: {
        remainingMainMs: { south: 0, north: 0 },
        turnStartedAt: Date.now() - 30001,
        turnExpiresAt: Date.now() - 1,
      },
    }),
  );
  await evictDurableObject(stub, { webSockets: "hibernate" });
  first.send({ type: "room.game.declare", roundId: room.roundId, positionRevision: 0 });
  const ended = shogi(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "waiting")).room,
  );
  expect(ended.lastRound?.game.result).toEqual({ winner: "north", reason: "timeout" });
  await first.waitFor("room.error");
  await runDurableObjectAlarm(stub);
  await evictDurableObject(stub, { webSockets: "hibernate" });
  expect((await fixtures.snapshot(room.id)).room).toEqual(ended);
  const replay = getShogiReplayContract.response.parse(
    await (
      await boundaryRequest(
        `${getShogiReplayContract.pathFor(room.id, room.roundId)}?instanceId=${room.instanceId}`,
      )
    ).json(),
  );
  expect(replay.events.map((e) => e.event)).toEqual([
    { type: "eliminate", side: "south", reason: "timeout" },
  ]);
});
test.each([1, 2] as const)(
  "CPU Lv%iは合法手を保存してから反映し、CPU戦の棋譜を保存する",
  async (level) => {
    const entry = await fixtures.create({ game: "shogi", name: "人間", quickPlay: true });
    const stub = env.GAME_ROOM.getByName(entry.room.id);
    await runInDurableObject(stub, (_instance, context) => {
      const progress = new ShogiProgress({
        storage: context.storage,
        membership: () => ({ playerId: entry.membership.playerId, role: "host" }),
        accountId: () => null,
      });
      const waiting = shogiRoomSchema.parse({
        ...entry.room,
        players: entry.room.players.map((p) => (p.kind === "cpu" ? { ...p, level } : p)),
      });
      if (waiting.status !== "waiting") throw Error("Expected waiting");
      const started = progress.start(waiting).room;
      const cpu = started.players.find((p) => p.kind === "cpu")!;
      const human = started.players.find((p) => p.kind === "human")!;
      let room = started;
      if (room.game.turn !== cpu.side) {
        const played = progress.play(room, "human", {
          type: "room.game.action",
          roundId: room.roundId,
          positionRevision: room.positionRevision,
          action: room.legalActions[0],
        });
        if (played.kind !== "playing") throw Error("Expected human move");
        room = played.room;
      }
      expect(progress.cpu(room, Date.now()).kind).toBe("unchanged");
      const job = context.storage.kv.get<ShogiCpuJob>("standard-shogi-cpu-job")!;
      expect(job.side).toBe(cpu.side);
      expect(room.legalActions).toContainEqual(job.action);
      expect(progress.cpu(room, job.applyAt - 1).kind).toBe("unchanged");
      const played = progress.cpu(room, job.applyAt);
      if (played.kind !== "playing") throw Error("Expected CPU action");
      expect(played.room.game.moveNumber).toBe(room.game.moveNumber + 1);
      expect(played.room.game.turn).toBe(human.side);
      expect(context.storage.kv.get("standard-shogi-cpu-job")).toBeUndefined();
      expect(progress.store().replayEvents(room.roundId, 0).at(-1)).toEqual({
        type: "action",
        side: cpu.side,
        action: job.action,
      });
      const ended = progress.eliminate(played.room, human.id, "resigned", job.applyAt + 1);
      if (ended.kind !== "finished") throw Error("Expected finished");
      expect(progress.finalize(ended).eventCount).toBe(room.game.moveNumber + 2);
      expect(
        Array.from(context.storage.kv.list({ prefix: "standard-shogi-match-pending:" })),
      ).toHaveLength(1);
    });
  },
);
test("CPUは手番外でも持将棋へ同意し、勝てる入玉宣言を着手より優先する", async () => {
  const entry = await fixtures.create({ game: "shogi", name: "人間", quickPlay: true });
  await runInDurableObject(env.GAME_ROOM.getByName(entry.room.id), (_instance, context) => {
    const progress = new ShogiProgress({
      storage: context.storage,
      membership: () => null,
      accountId: () => null,
    });
    const waiting = shogiRoomSchema.parse(entry.room);
    if (waiting.status !== "waiting") throw Error("Expected waiting");
    const started = progress.start(waiting).room;
    const cpu = started.players.find((p) => p.kind === "cpu")!;
    const human = started.players.find((p) => p.kind === "human")!;
    const state = enteringState({ south: cpu.id, north: human.id });
    const room = shogiRoomSchema.parse({
      ...started,
      players: started.players.map((p) => ({ ...p, side: p.id === cpu.id ? "south" : "north" })),
      game: progress.store().saveState(started.roundId, state),
      ...getActionAvailability(state),
      checkState: getCheckState(state),
    });
    if (room.status !== "playing") throw Error("Expected playing");
    progress.cpu(room, Date.now());
    const job = context.storage.kv.get<ShogiCpuJob>("standard-shogi-cpu-job")!;
    expect(job.action).toBe("declaration");
    const declared = progress.cpu(room, job.applyAt);
    expect(declared.kind === "finished" && declared.game.result).toEqual({
      winner: "south",
      reason: "declaration",
    });
    const humanTurn = shogiRoomSchema.parse({
      ...room,
      game: { ...room.game, turn: "north", drawProposals: ["north"] },
    });
    if (humanTurn.status !== "playing") throw Error("Expected playing");
    const agreed = progress.cpuDraw(humanTurn, Date.now());
    expect(agreed.kind === "finished" && agreed.game.result).toEqual({
      winner: null,
      reason: "impasse",
    });
  });
});
