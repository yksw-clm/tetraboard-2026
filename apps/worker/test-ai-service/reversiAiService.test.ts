import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  publicReversiMatchDetailSchema,
  reversiReplaySchema,
  reversiRoomSchema,
  type ReversiRoom,
} from "@tetraboard/protocol";
import { applyAction, chooseCpuMove, getLegalMoves, type ReversiState } from "@tetraboard/reversi";
import { replayKey, roomStorageKey } from "../src/adapters/room/games/progressHelpers";
import { boundaryRequest, RoomBoundaryFixtures } from "../test/roomBoundaryFixtures";

let fixtures = new RoomBoundaryFixtures();
let now: number;

afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
  fixtures = new RoomBoundaryFixtures();
});

async function setup() {
  now = Date.now() + 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const entry = await fixtures.create({
    game: "reversi",
    name: "人間",
    quickPlay: true,
    cpuLevel: 2,
  });
  const host = await fixtures.connect(entry);
  const stub = env.GAME_ROOM.getByName(entry.room.id);
  const read = () =>
    runInDurableObject(stub, (_, ctx) =>
      reversiRoomSchema.parse(ctx.storage.kv.get(roomStorageKey)),
    );
  const alarm = () =>
    runInDurableObject(stub, async (instance) => {
      const original = Reflect.get(instance, "env");
      Reflect.set(instance, "env", { ...original, AI_REVERSI_ENABLED: "true" });
      try {
        await instance.alarm();
      } finally {
        Reflect.set(instance, "env", original);
      }
    });
  const isCpu = (room: Awaited<ReturnType<typeof read>>) =>
    room.status === "playing" &&
    room.players.some((player) => player.kind === "cpu" && player.color === room.game.turn);
  async function playHuman() {
    const room = await read();
    if (room.status !== "playing") throw Error("Expected playing room");
    host.send({
      type: "room.game.action",
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      action: { type: "placeStone", position: getLegalMoves(room.game)[0]! },
    });
    await host.waitFor(
      "room.snapshot",
      (message) =>
        message.room.status === "waiting" ||
        (message.room.game?.moveNumber ?? 0) > room.game.moveNumber,
    );
  }
  host.send({ type: "room.game.start" });
  await host.waitFor("room.snapshot", (message) => message.room.status === "playing");
  if (!isCpu(await read())) await playHuman();
  return { entry, stub, read, alarm, playHuman, isCpu };
}

async function seedFallbackEndgame(stub: DurableObjectStub) {
  return runInDurableObject(stub, (_, { storage }) => {
    const room = reversiRoomSchema.parse(storage.kv.get(roomStorageKey));
    if (room.status !== "playing") throw Error("Expected playing room");
    const cpu = room.players.find((player) => player.kind === "cpu");
    if (!cpu) throw Error("Expected a CPU player");
    const replay = reversiReplaySchema.parse(storage.kv.get(replayKey));
    let game = room.game;
    // 先頭の合法手を積み、CPUの色ごとに途中の1手を変えて残り4手をCPU、人間、CPU、人間の順にします。
    const branch =
      cpu.color === "black"
        ? { moveNumber: 52, position: { x: 2, y: 7 } }
        : { moveNumber: 20, position: { x: 3, y: 5 } };
    while (game.moveNumber < 56) {
      const position =
        game.moveNumber === branch.moveNumber ? branch.position : getLegalMoves(game)[0];
      const result = applyAction(game, { type: "placeStone", position });
      if (!result.ok) throw Error("Illegal fixture move");
      const step = reversiReplaySchema.shape.steps.element.parse({
        action: { type: "place", color: game.turn, position },
        game: result.state,
        passedColors: result.passedColors,
      });
      if (step.game.status !== "playing") throw Error("Fixture ended before the CPU turn");
      replay.steps.push(step);
      game = step.game;
    }
    if (game.turn !== cpu.color) throw Error("Expected a CPU turn in the endgame fixture");
    const endgame = {
      ...room,
      game,
      positionRevision: room.positionRevision + game.moveNumber - room.game.moveNumber,
    };
    storage.kv.put(roomStorageKey, endgame);
    storage.kv.put(replayKey, replay);
    return endgame;
  });
}

test("リバーシAIが失敗した局では既存Lv2の着手を適用して棋譜と代替手の記録を保存する", async () => {
  const { read, alarm, entry, playHuman, isCpu, stub } = await setup();
  let room: ReversiRoom = await seedFallbackEndgame(stub);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(new URL(String(url)).pathname).toBe("/v1/reversi/move");
    return Response.json({ error: "engine_failed" }, { status: 503 });
  });
  const fallbackSteps = [];
  for (const turn of [1, 2]) {
    if (room.status !== "playing" || !isCpu(room)) throw Error(`Expected CPU turn ${turn}`);
    const { game, clock } = room;
    const fallback = chooseCpuMove(game, 2);
    expect(fallback).not.toBeNull();
    expect(fallback).not.toEqual(getLegalMoves(game)[0]);

    now = clock.turnStartedAt + 2000;
    await alarm();
    expect(fetchMock).toHaveBeenCalledTimes(turn);
    expect((await read()).game).toEqual(game);
    await alarm();
    const after = await read();
    expect(after.game?.moveNumber).toBe(game.moveNumber + 1);
    expect(after.game?.lastMove).toEqual(fallback);
    expect(isCpu(after)).toBe(false);
    fallbackSteps.push({
      index: game.moveNumber,
      action: { type: "place", color: game.turn, position: fallback },
    });

    await playHuman();
    room = await read();
  }
  expect(fetchMock).toHaveBeenCalledTimes(2);
  if (!room.lastRound) throw Error("Expected a completed round");
  const { id } = room.lastRound.replay;
  await fixtures.snapshot(entry.room.id);
  const saved = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
    .bind(id)
    .first<{ record_json: string }>();
  expect(JSON.parse(saved!.record_json).aiFallback).toBe(true);
  const response = await boundaryRequest(`/matches/${id}`);
  expect(response.status).toBe(200);
  const { match } = await response.json<{ match: unknown }>();
  expect(match).not.toHaveProperty("aiFallback");
  const detail = publicReversiMatchDetailSchema.parse(match);
  expect(detail.game).toEqual(room.lastRound.game);
  expect(detail.replay).toEqual(room.lastRound.replay);
  for (const { index, action } of fallbackSteps) {
    expect(detail.replay.steps[index]?.action).toEqual(action);
  }
});

test("リバーシAIの応答待ちに時計が切れたら候補手を適用しない", async () => {
  const { read, alarm } = await setup();
  const before = await read();
  if (before.status !== "playing") throw Error("Expected playing room");
  now = before.clock.turnStartedAt + 2000;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_, options) => {
    const request = JSON.parse(String(options?.body));
    now = before.clock.turnExpiresAt;
    return Response.json({
      request_id: request.request_id,
      position_revision: request.position_revision,
      engine_version: "egaroucid-console-7.8.2-0c1b84ef",
      level: 4,
      position: getLegalMoves(before.game)[0],
    });
  });
  await alarm();
  const ended = await read();
  expect(ended.status).toBe("waiting");
  expect(ended.lastRound?.game.moveNumber).toBe(before.game.moveNumber);
  expect(ended.lastRound?.replay.steps.at(-1)?.action).toMatchObject({
    type: "eliminate",
    reason: "timeout",
  });
});

test.skipIf(env.AI_REVERSI_ENABLED !== "true")(
  "リバーシの実AI対局を完走し、保存棋譜の全手を再生できる",
  async () => {
    const { read, alarm, entry, playHuman, isCpu } = await setup();
    const fetch = globalThis.fetch;
    const replies: { status: number; position: { x: number; y: number } }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await fetch(...args);
      const { position } = await response.clone().json<{ position: { x: number; y: number } }>();
      replies.push({ status: response.status, position });
      return response;
    });
    let room = await read();
    let cpuMoves = 0;
    for (let i = 0; room.status === "playing" && i < 60; i++) {
      if (isCpu(room)) {
        now = room.clock.turnStartedAt + 2000;
        await alarm();
        const response = replies[cpuMoves];
        if (!response) throw Error("Expected an AI response");
        expect(response.status).toBe(200);
        const { position: move } = response;
        expect(getLegalMoves(room.game)).toContainEqual(move);
        await alarm();
        const after = await read();
        expect((after.game ?? after.lastRound?.game)?.lastMove).toEqual(move);
        cpuMoves++;
      } else {
        await playHuman();
      }
      room = await read();
    }
    expect(cpuMoves).toBeGreaterThan(0);
    const id = room.lastRound?.replay.id;
    expect(id).toBeDefined();
    await fixtures.snapshot(entry.room.id);
    const response = await boundaryRequest(`/matches/${id}`);
    expect(response.status).toBe(200);
    const { match } = await response.json<{ match: unknown }>();
    const saved = publicReversiMatchDetailSchema.parse(match);
    let state: ReversiState = saved.replay.initial;
    for (const step of saved.replay.steps) {
      if (step.action.type !== "place") throw Error("Expected a completed game");
      const result = applyAction(state, { type: "placeStone", position: step.action.position });
      if (!result.ok) throw Error("Expected legal replay move");
      expect(step.passedColors).toEqual(result.passedColors);
      expect(step.game).toEqual(result.state);
      state = result.state;
    }
    expect(state).toEqual(saved.game);
  },
);
