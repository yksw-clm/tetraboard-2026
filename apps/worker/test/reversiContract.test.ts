import { reversiReplaySchema, reversiRoomSchema } from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/reversi";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import archive from "../../../test-fixtures/matches/reversi-standard-draw.json";
import { playerTokenHash } from "../src/adapters/room/state";
import { gameDefinitions } from "../src/rooms/gameDefinitions";
import { matchStartKey, type MatchStart } from "../src/adapters/record/reversiMatchStore";
import { RoomBoundaryFixtures } from "./roomBoundaryFixtures";

let fixtures: RoomBoundaryFixtures;
beforeEach(() => {
  fixtures = new RoomBoundaryFixtures();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.dispose();
});

async function setup(quick = false) {
  const entry = await fixtures.create({ game: "reversi", name: "本人", quickPlay: quick });
  const host = await fixtures.connect(entry);
  const joined = quick ? null : await fixtures.join(entry.room.id, "相手");
  const guest = joined ? await fixtures.connect(joined) : null;
  host.send({ type: "room.ready.set", ready: true });
  guest?.send({ type: "room.ready.set", ready: true });
  await host.waitFor("room.snapshot", (m) => m.room.players.every((p) => p.ready));
  host.send({ type: "room.game.start" });
  const room = reversiRoomSchema.parse(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "playing")).room,
  );
  if (room.status !== "playing") throw Error("Expected playing");
  const blackIsHost =
    room.players.find((p) => p.color === "black")?.id === entry.membership.playerId;
  return {
    entry,
    host,
    guest,
    room,
    black: blackIsHost ? host : guest!,
    white: blackIsHost ? guest! : host,
    stub: env.GAME_ROOM.getByName(entry.room.id),
  };
}

test("局ID・版の古い着手を手番・時計より先に拒否し、受理ごとに版を増やす", async () => {
  const { entry, room, black, white, host, stub } = await setup();
  const action = { type: "placeStone" as const, position: getLegalMoves(room.game)[0]! };
  for (const metadata of [
    { roundId: crypto.randomUUID(), positionRevision: 0 },
    { roundId: room.roundId, positionRevision: 1 },
  ]) {
    white.send({ type: "room.game.action", action, ...metadata });
    expect((await white.waitFor("room.error")).error).toBe("stale_position");
  }
  const unchanged = reversiRoomSchema.parse((await fixtures.snapshot(entry.room.id)).room);
  expect(unchanged).toEqual(room);
  await runInDurableObject(stub, (instance) => {
    const progress = Reflect.get(instance, "runtime").gameAdapter(room);
    const expired = { ...room, clock: { ...room.clock, turnExpiresAt: Date.now() - 1 } };
    expect(
      progress.play(expired, "invalid-token", {
        type: "room.game.action",
        action,
        roundId: room.roundId,
        positionRevision: 0,
      }),
    ).toMatchObject({ error: "unauthorized" });
    const hash = playerTokenHash(
      Reflect.get(instance, "runtime"),
      room.players.find((p) => p.color === "white")!.id,
    );
    expect(
      progress.play(expired, hash, {
        type: "room.game.action",
        action,
        roundId: room.roundId,
        positionRevision: 1,
      }),
    ).toMatchObject({ error: "stale_position" });
    expect(progress.resign(expired, hash)).toMatchObject({ error: "time_expired" });
  });
  black.send({ type: "room.game.action", action, roundId: room.roundId, positionRevision: 0 });
  const moved = reversiRoomSchema.parse(
    (await host.waitFor("room.snapshot", (m) => m.room.game?.moveNumber === 1)).room,
  );
  expect(moved.positionRevision).toBe(1);
  expect(moved.roundId).toBe(room.roundId);
  black.send({ type: "room.game.action", action, roundId: room.roundId, positionRevision: 0 });
  expect((await black.waitFor("room.error")).error).toBe("stale_position");
  if (moved.status !== "playing") throw Error("Expected playing");
  white.send({
    type: "room.game.action",
    action: { type: "placeStone", position: getLegalMoves(moved.game)[0]! },
    roundId: moved.roundId,
    positionRevision: 1,
  });
  expect(
    (await host.waitFor("room.snapshot", (m) => m.room.game?.moveNumber === 2)).room,
  ).toMatchObject({ positionRevision: 2 });
});

test("版のない保存状態は棋譜IDと版0で読み込み、移行を保存する", async () => {
  const { entry, room, black, host, stub } = await setup();
  await runInDurableObject(stub, (_instance, state) => {
    const saved = state.storage.kv.get<Record<string, unknown>>("room")!;
    delete saved.roundId;
    delete saved.positionRevision;
    state.storage.kv.delete("room-state-version");
    state.storage.kv.put("room", saved);
    expect(state.storage.kv.get("room")).not.toHaveProperty("roundId");
  });
  expect(await stub.getShareMetadata(room.instanceId)).not.toBeNull();
  await runInDurableObject(stub, (_, state) => {
    expect(state.storage.kv.get("room")).not.toHaveProperty("roundId");
    expect(state.storage.kv.get("room-state-version")).toBeUndefined();
  });
  const loaded = reversiRoomSchema.parse(await stub.getRoom());
  expect(loaded).toMatchObject({ roundId: room.roundId, positionRevision: 0 });
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.kv.get("room")).toMatchObject({
      roundId: room.roundId,
      positionRevision: 0,
    });
    expect(state.storage.kv.get("room-state-version")).toBe(2);
  });
  black.send({
    type: "room.game.action",
    action: { type: "placeStone", position: getLegalMoves(room.game)[0]! },
    roundId: loaded.roundId!,
    positionRevision: 0,
  });
  await host.waitFor("room.snapshot", (m) => m.room.game?.moveNumber === 1);
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.kv.get("room")).toMatchObject({
      roundId: room.roundId,
      positionRevision: 1,
    });
  });
  expect(
    reversiRoomSchema.parse((await fixtures.snapshot(entry.room.id)).room).positionRevision,
  ).toBe(1);
});

test("版のない旧タブの着手はinvalid_requestで拒否する", async () => {
  const { room, black } = await setup();
  black.send({
    type: "room.game.action",
    action: { type: "placeStone", position: getLegalMoves(room.game)[0]! },
  });
  expect((await black.waitFor("room.error")).error).toBe("invalid_request");
});

async function cpuTurn() {
  const data = await setup(true);
  let room = data.room;
  if (room.players.find((p) => p.color === room.game.turn)?.kind === "human") {
    data.host.send({
      type: "room.game.action",
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      action: { type: "placeStone", position: getLegalMoves(room.game)[0]! },
    });
    const moved = reversiRoomSchema.parse(
      (await data.host.waitFor("room.snapshot", (m) => m.room.game?.moveNumber === 1)).room,
    );
    if (moved.status !== "playing") throw Error("Expected playing");
    room = moved;
  }
  return { ...data, room };
}

test("GET・WebSocketはCPUを動かさず、2秒のAlarmだけで進み次の期限を設定する", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { room, host, entry, stub } = await cpuTurn();
  const before = room.game.moveNumber;
  const due = room.clock.turnStartedAt + 2000;
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.getAlarm()).toBe(due);
  });
  now = due - 1;
  await runInDurableObject(stub, (instance) => instance.alarm());
  expect((await stub.getRoom())?.game?.moveNumber).toBe(before);
  now = due;
  expect((await fixtures.snapshot(entry.room.id)).room.game?.moveNumber).toBe(before);
  host.send({ type: "room.ready.set", ready: true });
  expect((await host.waitFor("room.error")).error).toBe("already_started");
  expect((await stub.getRoom())?.game?.moveNumber).toBe(before);
  await runDurableObjectAlarm(stub);
  await host.waitFor("room.snapshot", (m) => m.room.game?.moveNumber === before + 1);
  await runInDurableObject(stub, async (_instance, state) => {
    const moved = reversiRoomSchema.parse(state.storage.kv.get("room"));
    expect(moved).toMatchObject({ positionRevision: room.positionRevision + 1 });
    expect(moved.game?.moveNumber).toBe(before + 1);
    expect(await state.storage.getAlarm()).toBeGreaterThan(now);
  });
});

test("CPUの選択直後に時計が切れたら着手せず時間切れを記録する", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { room, host, stub } = await cpuTurn();
  now = room.clock.turnStartedAt + 2000;
  const choose = gameDefinitions.reversi.cpu.chooseAction;
  vi.spyOn(gameDefinitions.reversi.cpu, "chooseAction").mockImplementation((...args) => {
    const action = choose(...args);
    now = room.clock.turnExpiresAt;
    return action;
  });
  await runDurableObjectAlarm(stub);
  const ended = reversiRoomSchema.parse(
    (await host.waitFor("room.snapshot", (m) => m.room.status === "waiting")).room,
  );
  expect(ended.lastRound?.game.moveNumber).toBe(room.game.moveNumber);
  expect(ended.lastRound?.game.result.reason).toBe("last_player");
  expect(ended.lastRound?.replay.steps.at(-1)?.action).toEqual({
    type: "eliminate",
    color: room.game.turn,
    reason: "timeout",
  });
});

test("相手の自動パス後も、人の送信なしで次のAlarmがCPUを進める", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { room, stub } = await setup(true);
  const replay = reversiReplaySchema.parse(archive.detail.replay);
  const beforePass = replay.steps[57]!.game;
  if (beforePass.status !== "playing") throw Error("Expected playing fixture");
  const savedRoom = reversiRoomSchema.parse({
    ...room,
    game: beforePass,
    positionRevision: 58,
    players: room.players.map((p) => ({ ...p, color: p.kind === "cpu" ? "black" : "white" })),
  });
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.kv.put("room", savedRoom);
    state.storage.kv.put("round-replay", {
      ...replay,
      id: room.roundId,
      steps: replay.steps.slice(0, 58),
    });
    const start = state.storage.kv.get<MatchStart>(matchStartKey)!;
    state.storage.kv.put(matchStartKey, {
      ...start,
      participants: start.participants.map((p) => ({
        ...p,
        color: p.kind === "cpu" ? "black" : "white",
      })),
    });
  });
  vi.spyOn(gameDefinitions.reversi.cpu, "chooseAction").mockImplementation((state) => {
    const action = replay.steps[state.moveNumber]!.action;
    if (action.type !== "place") throw Error("Expected placement");
    return { type: "placeStone", position: action.position };
  });
  now = room.clock.turnStartedAt + 2000;
  await runInDurableObject(stub, (instance) => instance.alarm());
  await runInDurableObject(stub, async (_instance, state) => {
    const moved = reversiRoomSchema.parse(state.storage.kv.get("room"));
    expect(moved.game).toEqual(replay.steps[58]!.game);
    expect(moved.positionRevision).toBe(59);
    expect(await state.storage.getAlarm()).toBe(now + 2000);
  });
  now += 2000;
  await runDurableObjectAlarm(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const ended = reversiRoomSchema.parse(state.storage.kv.get("room"));
    expect(ended.status).toBe("waiting");
    expect(ended.lastRound?.game).toEqual(archive.detail.game);
    expect(ended.lastRound?.replay.steps).toEqual(replay.steps);
  });
});
