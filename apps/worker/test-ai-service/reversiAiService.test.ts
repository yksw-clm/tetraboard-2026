import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { publicReversiMatchDetailSchema, reversiRoomSchema } from "@tetraboard/protocol";
import { applyAction, chooseCpuMove, getLegalMoves, type ReversiState } from "@tetraboard/reversi";
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
    runInDurableObject(stub, (_, ctx) => reversiRoomSchema.parse(ctx.storage.kv.get("room")));
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
  return { entry, read, alarm, playHuman, isCpu };
}

test("リバーシAIが失敗した局では既存Lv2の着手を適用して棋譜と代替手の記録を保存する", async () => {
  const { read, alarm, entry, playHuman, isCpu } = await setup();
  const before = await read();
  if (before.status !== "playing") throw Error("Expected playing room");
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    expect(new URL(String(url)).pathname).toBe("/v1/reversi/move");
    return Response.json({ error: "engine_failed" }, { status: 503 });
  });
  now = before.clock.turnStartedAt + 2000;
  await alarm();
  expect((await read()).game).toEqual(before.game);
  await alarm();
  const after = await read();
  const fallback = chooseCpuMove(before.game, 2)!;
  expect(after.game?.lastMove).toEqual(fallback);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  let room = after;
  for (let i = 0; room.status === "playing" && i < 60; i++) {
    if (isCpu(room)) {
      now = room.clock.turnStartedAt + 2000;
      await alarm();
      await alarm();
    } else {
      await playHuman();
    }
    room = await read();
  }
  const id = room.lastRound?.replay.id;
  expect(id).toBeDefined();
  await fixtures.snapshot(entry.room.id);
  const saved = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id=?")
    .bind(id)
    .first<{ record_json: string }>();
  expect(JSON.parse(saved!.record_json).aiFallback).toBe(true);
  const response = await boundaryRequest(`/matches/${id}`);
  expect(response.status).toBe(200);
  const { match } = await response.json<{ match: unknown }>();
  expect(match).not.toHaveProperty("aiFallback");
  expect(publicReversiMatchDetailSchema.parse(match).game).toEqual(room.lastRound?.game);
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
