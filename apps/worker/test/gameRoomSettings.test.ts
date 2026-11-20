import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { createRoomContract, roundReplaySchema, roomTimeControl } from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/four-reversi";
import { expect, test, vi } from "vitest";
import {
  registerGameRoomFixtures,
  createRoom,
  joinRoom,
  authenticatedRoom,
  getRoom,
  setRoomDeadlines,
  baseUrl,
  getMetadata,
  fourPlayers,
  readyPlayers,
  openRoom,
  listRooms,
} from "./gameRoomFixtures";

registerGameRoomFixtures();

test("ホストだけが待機中のCPU席を追加・変更・削除できる", async () => {
  const created = await createRoom();
  const joined = await joinRoom(created.room.id, "参加者");
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  const participant = await authenticatedRoom(created.room.id, joined.membership.token);

  participant.send({ type: "room.cpu.add", level: 1 });
  expect((await participant.nextType("room.error")).error).toBe("forbidden");
  expect((await getRoom(created.room.id)).players).toHaveLength(2);

  host.send({ type: "room.cpu.add", level: 1 });
  const withCpu = await host.nextSnapshotWhere((room) => room.players.length === 3);
  const cpu = withCpu.players.find((player) => player.kind === "cpu");
  expect(cpu?.kind).toBe("cpu");
  if (cpu?.kind !== "cpu") throw new Error("CPU was not added");
  expect(cpu.level).toBe(1);
  expect(cpu.reconnectDeadline).toBeNull();
  host.send({ type: "room.cpu.level.set", playerId: cpu.id, level: 2 });
  const changed = await host.nextSnapshotWhere((room) =>
    room.players.some(
      (player) => player.id === cpu.id && player.kind === "cpu" && player.level === 2,
    ),
  );
  expect(changed.players.find((player) => player.id === cpu.id)?.kind).toBe("cpu");
  host.send({ type: "room.cpu.add", level: 1 });
  await host.nextSnapshotWhere((room) => room.players.length === 4);
  host.send({ type: "room.cpu.add", level: 1 });
  expect((await host.nextType("room.error")).error).toBe("room_full");
  host.send({ type: "room.cpu.remove", playerId: cpu.id });
  const removed = await host.nextSnapshotWhere((room) => room.players.length === 3);
  expect(removed.players.some((player) => player.id === cpu.id)).toBe(false);
  expect(await getRoom(created.room.id)).toEqual(removed);
});

test.each([
  roomTimeControl,
  { mainTimeMs: 0, byoyomiMs: 10_000 },
  { mainTimeMs: 60_000, byoyomiMs: 0 },
] as const)("すぐ遊ぶのCPU手番は $mainTimeMs + $byoyomiMs で保存・配信する", async (control) => {
  const created = await createRoom(true, "singles", control);
  const id = created.room.id;
  expect(created.room.players.filter((player) => player.kind === "human")).toHaveLength(1);
  expect(created.room.players.filter((player) => player.kind === "cpu")).toHaveLength(3);
  expect(created.room.players.every((player) => player.ready)).toBe(true);
  const host = await authenticatedRoom(id, created.membership.token);
  host.send({ type: "room.game.start" });
  let room = await host.nextSnapshotWhere((snapshot) => snapshot.status === "playing");
  if (room.status !== "playing") throw new Error("Game did not start");
  const openingTurn = room.game.turn;
  if (room.players.find((player) => player.color === openingTurn)?.kind === "human") {
    host.send({
      type: "room.game.action",
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      action: { type: "placeStone", position: getLegalMoves(room.game)[0] },
    });
    room = await host.nextSnapshotWhere(
      (snapshot) => snapshot.status === "playing" && snapshot.game.moveNumber === 1,
    );
    if (room.status !== "playing") throw new Error("Game did not continue");
  }
  const cpuTurn = room.game.turn;
  expect(room.players.find((player) => player.color === cpuTurn)?.kind).toBe("cpu");
  const before = room.game.moveNumber;
  await setRoomDeadlines(id, (current) => ({
    ...current,
    clock: {
      ...current.clock,
      turnStartedAt: Date.now() - 2001,
      turnExpiresAt: Date.now() + control.mainTimeMs + control.byoyomiMs - 2001,
    },
  }));
  expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
  await runInDurableObject(env.GAME_ROOM.getByName(id), async (_, state) => {
    const job = state.storage.kv.get<{ applyAt: number }>("four-reversi-cpu-job")!;
    state.storage.kv.put("four-reversi-cpu-job", { ...job, applyAt: Date.now() - 1 });
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
  const moved = await host.nextSnapshotWhere(
    (snapshot) => snapshot.status !== "waiting" && snapshot.game.moveNumber > before,
  );
  expect(moved.status).not.toBe("waiting");
  if (moved.status === "playing") {
    expect(moved.clock.turnExpiresAt - moved.clock.turnStartedAt).toBe(
      moved.clock.remainingMainMs[moved.game.turn] + control.byoyomiMs,
    );
  }
  expect(await getRoom(id)).toEqual(moved);
  await runInDurableObject(env.GAME_ROOM.getByName(id), (_instance, state) => {
    const replay = roundReplaySchema.parse(state.storage.kv.get("round-replay"));
    expect(replay.steps.at(-1)?.action).toMatchObject({ type: "place", color: cpuTurn });
    if (moved.status === "playing") expect(replay.steps.at(-1)?.game).toEqual(moved.game);
  });
});

test("ルーム作成のモードは必須で、すぐ遊ぶにも選択したモードを保存する", async () => {
  for (const body of [
    { name: "ホスト", quickPlay: false },
    { name: "ホスト", quickPlay: false, mode: "other" },
  ]) {
    const response = await exports.default.fetch(
      new AcceptedGameRequest(`${baseUrl}${createRoomContract.path}`, {
        method: createRoomContract.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({ error: "invalid_request" });
  }

  const singles = await createRoom(false, "singles");
  const doubles = await createRoom(true, "doubles");
  expect(singles.room.settings).toEqual({
    game: "four-reversi",
    mode: "singles",
    timeControl: roomTimeControl,
  });
  expect(singles.room.players).toHaveLength(1);
  expect(doubles.room.settings.mode).toBe("doubles");
  expect(doubles.room.players.filter((player) => player.kind === "cpu")).toHaveLength(3);
  expect(doubles.room.players.every((player) => player.ready)).toBe(true);
});

test("待機中のモード変更はホストのみ可能で、人間のReadyを解除する", async () => {
  const created = await createRoom();
  const joined = await joinRoom(created.room.id, "二人目");
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  const guest = await authenticatedRoom(created.room.id, joined.membership.token);
  host.send({ type: "room.ready.set", ready: true });
  await host.nextSnapshotWhere((room) => room.players[0].ready);
  guest.send({ type: "room.ready.set", ready: true });
  await host.nextSnapshotWhere((room) => room.players[1].ready);

  guest.send({ type: "room.mode.set", mode: "doubles" });
  expect((await guest.nextType("room.error")).error).toBe("forbidden");
  const before = await getMetadata(created.room.id);
  host.send({ type: "room.mode.set", mode: "doubles" });
  const changed = await host.nextSnapshotWhere((room) => room.settings.mode === "doubles");
  expect(changed.players.filter((player) => player.kind === "human" && player.ready)).toHaveLength(
    0,
  );
  expect((await getMetadata(created.room.id))?.updatedAtMs).toBeGreaterThan(before!.updatedAtMs);
  expect((await getRoom(created.room.id)).settings.mode).toBe("doubles");

  const updatedAtMs = (await getMetadata(created.room.id))!.updatedAtMs;
  host.send({ type: "room.mode.set", mode: "doubles" });
  await host.nextSnapshotWhere((room) => room.settings.mode === "doubles");
  expect((await getMetadata(created.room.id))?.updatedAtMs).toBe(updatedAtMs);
});

test("すぐ遊ぶのモード変更ではCPUだけがReadyを維持する", async () => {
  const created = await createRoom(true);
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  host.send({ type: "room.mode.set", mode: "doubles" });
  const changed = await host.nextSnapshotWhere((room) => room.settings.mode === "doubles");
  expect(changed.players.filter((player) => player.kind === "human" && player.ready)).toHaveLength(
    0,
  );
  expect(changed.players.filter((player) => player.kind === "cpu" && player.ready)).toHaveLength(3);
});

test("時間設定は待機中のホストだけが変更でき、準備解除・配信・永続化・公開索引へ反映する", async () => {
  const setup = await fourPlayers();
  await readyPlayers(setup.id, setup.connections);
  const host = setup.connections[0];
  const observer = await openRoom(setup.id);
  const control = { mainTimeMs: 60_000, byoyomiMs: 10_000 } as const;
  setup.connections[1].send({ type: "room.time-control.set", timeControl: control });
  expect((await setup.connections[1].nextType("room.error")).error).toBe("forbidden");
  observer.send({ type: "room.time-control.set", timeControl: control });
  expect((await observer.nextType("room.error")).error).toBe("unauthorized");
  host.sendRaw({ type: "room.time-control.set", timeControl: { mainTimeMs: 0, byoyomiMs: 0 } });
  expect((await host.nextType("room.error")).error).toBe("invalid_request");
  host.send({ type: "room.time-control.set", timeControl: control });
  const updated = await host.nextSnapshotWhere(
    (room) => room.settings.timeControl.mainTimeMs === 60_000,
  );
  expect(updated.players.every((player) => !player.ready)).toBe(true);
  expect(
    (await observer.nextSnapshotWhere((room) => room.settings.timeControl.mainTimeMs === 60_000))
      .settings.timeControl,
  ).toEqual(control);
  expect((await getRoom(setup.id)).settings.timeControl).toEqual(control);
  await vi.waitFor(async () => {
    let page = await listRooms();
    let metadata = page.rooms.find((room) => room.id === setup.id);
    while (!metadata && page.nextCursor) {
      page = await listRooms(page.nextCursor);
      metadata = page.rooms.find((room) => room.id === setup.id);
    }
    expect(metadata?.timeControl).toEqual(control);
  });
  expect((await openRoom(setup.id)).initialSnapshot?.room.settings.timeControl).toEqual(control);
  await readyPlayers(setup.id, setup.connections);
  const ready = await getRoom(setup.id);
  host.send({ type: "room.time-control.set", timeControl: control });
  const unchanged = await host.nextSnapshotWhere((room) =>
    room.players.every((player) => player.ready),
  );
  expect(unchanged.publicUpdatedAtMs).toBe(ready.publicUpdatedAtMs);
  expect(unchanged.lastActivityAtMs).toBe(ready.lastActivityAtMs);
  host.send({ type: "room.game.start" });
  const started = await host.nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Not playing");
  expect(started.clock.turnExpiresAt - started.clock.turnStartedAt).toBe(70_000);
  host.send({ type: "room.time-control.set", timeControl: roomTimeControl });
  expect((await host.nextType("room.error")).error).toBe("already_started");
});

test.each([
  { mainTimeMs: 0, byoyomiMs: 10_000 },
  { mainTimeMs: 60_000, byoyomiMs: 0 },
  { mainTimeMs: 180_000, byoyomiMs: 30_000 },
] as const)("リバーシの着手・時間切れ・再戦は $mainTimeMs + $byoyomiMs を使う", async (control) => {
  const setup = await fourPlayers(control);
  await readyPlayers(setup.id, setup.connections);
  setup.connections[0].send({ type: "room.game.start" });
  let room = await setup.connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (room.status !== "playing") throw new Error("Not playing");
  expect(room.clock.turnExpiresAt - room.clock.turnStartedAt).toBe(
    control.mainTimeMs + control.byoyomiMs,
  );
  const black = room.players.findIndex((p) => p.color === "black");
  setup.connections[black].send({
    type: "room.game.action",
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    action: { type: "placeStone", position: { x: 2, y: 3 } },
  });
  room = await setup.connections[0].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.moveNumber === 1,
  );
  if (room.status !== "playing") throw new Error("Not playing");
  expect(room.clock.turnExpiresAt - room.clock.turnStartedAt).toBe(
    control.mainTimeMs + control.byoyomiMs,
  );
  const turn = room.game.turn;
  const turnIndex = room.players.findIndex((p) => p.color === turn);
  await setRoomDeadlines(setup.id, (current) => ({
    ...current,
    clock: { ...current.clock, turnExpiresAt: Date.now() },
  }));
  setup.connections[turnIndex].send({
    type: "room.game.action",
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    action: { type: "placeStone", position: getLegalMoves(room.game)[0] },
  });
  expect((await setup.connections[turnIndex].nextType("room.error")).error).toBe("stale_position");
  const expired = await setup.connections[0].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.eliminatedColors.includes(turn),
  );
  if (expired.status !== "playing") throw new Error("Not playing");
  expect(
    expired.eliminations.some((entry) => entry.color === turn && entry.reason === "timeout"),
  ).toBe(true);
  room = expired;
  while (room.status === "playing") {
    const currentTurn = room.game.turn;
    const index = room.players.findIndex((p) => p.color === currentTurn);
    const eliminated = room.game.eliminatedColors.length;
    setup.connections[index].send({ type: "room.game.resign" });
    room = await setup.connections[0].nextSnapshotWhere(
      (room) => room.status === "waiting" || room.game.eliminatedColors.length > eliminated,
    );
  }
  expect(room.settings.timeControl).toEqual(control);
  const lastRound = room.lastRound;
  const matchId = lastRound!.replay!.id;
  setup.connections[0].send({ type: "room.time-control.set", timeControl: roomTimeControl });
  const changed = await setup.connections[0].nextSnapshotWhere(
    (room) => room.settings.timeControl.mainTimeMs === 300_000,
  );
  expect(changed.lastRound).toEqual(lastRound);
  await vi.waitFor(async () => {
    const row = await env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
      .bind(matchId)
      .first<{ record_json: string }>();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.record_json).settings.timeControl).toEqual(control);
  });
  await readyPlayers(setup.id, setup.connections);
  setup.connections[0].send({ type: "room.game.start" });
  const rematch = await setup.connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (rematch.status !== "playing") throw new Error("Not playing");
  expect(rematch.roundId).not.toBe(matchId);
  expect(rematch.positionRevision).toBe(0);
  expect(rematch.clock.turnExpiresAt - rematch.clock.turnStartedAt).toBe(330_000);
});
