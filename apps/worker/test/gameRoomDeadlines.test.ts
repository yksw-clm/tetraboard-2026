import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { getRoomContract, roundReplaySchema } from "@tetraboard/protocol";
import { expect, test } from "vitest";
import {
  registerGameRoomFixtures,
  startFourPlayerRoom,
  openRoom,
  authenticatedRoom,
  baseUrl,
  fourPlayers,
  readyPlayers,
  getRoom,
  getMembership,
  leaveRoom,
  expectPending,
  expirePlayers,
  setRoomDeadlines,
} from "./gameRoomFixtures";

registerGameRoomFixtures();

test("接続情報は観戦者にも配信し、脱落後の切断と復帰も反映する", async () => {
  const setup = await startFourPlayerRoom();
  const observer = await openRoom(setup.id);
  expect(observer.initialSnapshot?.presence.hostPlayerId).toBe(setup.participants[0].playerId);
  expect(observer.initialSnapshot?.presence.connectedPlayerIds).toHaveLength(4);
  const index = setup.room.players.findIndex((player) => player.color === setup.room.game.turn);
  const playerId = setup.participants[index].playerId;
  setup.connections[index].send({ type: "room.game.resign" });
  await observer.nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.eliminatedColors.length === 1,
  );
  setup.connections[index].close();
  let snapshot;
  do {
    snapshot = await observer.nextType("room.snapshot");
  } while (snapshot.presence.connectedPlayerIds.includes(playerId));
  expect(snapshot.room.players).toHaveLength(4);
  expect(
    snapshot.room.players.find((player) => player.id === playerId)?.reconnectDeadline,
  ).toBeGreaterThan(Date.now());
  await authenticatedRoom(setup.id, setup.participants[index].token);
  do {
    snapshot = await observer.nextType("room.snapshot");
  } while (!snapshot.presence.connectedPlayerIds.includes(playerId));
  expect(snapshot.room.players).toHaveLength(4);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}/rooms/${setup.id}`),
  );
  expect(getRoomContract.response.parse(await response.json()).presence).toEqual(snapshot.presence);
});

test("手番外の投了は拒否し、手番の投了は脱落と配信を行う", async () => {
  const { id, participants, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  const started = await connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Game did not start");
  const black = started.players.findIndex((player) => player.color === "black");
  const other = started.players.findIndex((player) => player.color !== "black");
  connections[other].send({ type: "room.game.resign" });
  expect((await connections[other].nextType("room.error")).error).toBe("not_your_turn");
  expect(await getRoom(id)).toEqual(started);

  connections[black].send({ type: "room.game.resign" });
  const updated = await connections[other].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.eliminatedColors.includes("black"),
  );
  expect(updated.status).toBe("playing");
  expect(await getRoom(id)).toEqual(updated);
  expect((await getMembership(id, participants[black].token)).status).toBe(200);
  connections[black].send({ type: "room.game.resign" });
  expect((await connections[black].nextType("room.error")).error).toBe("already_eliminated");
});

test("対局中の退室は脱落させ、資格を失効する", async () => {
  const { id, participants, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  const started = await connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Game did not start");
  const other = started.players.findIndex((player) => player.color !== "black");
  const color = started.players[other].color;
  expect((await leaveRoom(id, participants[other].token)).status).toBe(204);
  const updated = await getRoom(id);
  expect(updated.status).toBe("playing");
  if (updated.status === "playing") {
    expect(updated.positionRevision).toBe(started.positionRevision + 1);
    expect(updated.game.moveNumber).toBe(started.game.moveNumber);
    expect(updated.game.turn).toBe(started.game.turn);
    expect(updated.game.eliminatedColors).toContain(color);
  }
  expect((await getMembership(id, participants[other].token)).status).toBe(401);
});

test("対局中の切断期限切れは脱落し、閲覧資格を残す", async () => {
  const { id, participants, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  const started = await connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Game did not start");
  const black = started.players.findIndex((player) => player.color === "black");
  connections[black].close();
  await expectPending(id, participants[black].playerId);
  await expirePlayers(id, [participants[black].playerId]);
  const updated = await getRoom(id);
  expect(updated.status).toBe("playing");
  if (updated.status === "playing") expect(updated.game.eliminatedColors).toEqual(["black"]);
  expect((await getMembership(id, participants[black].token)).status).toBe(200);
  const returned = await authenticatedRoom(id, participants[black].token);
  returned.send({ type: "room.game.resign" });
  expect((await returned.nextType("room.error")).error).toBe("already_eliminated");
});

test("同時に期限切れになった対局者は入室順に脱落する", async () => {
  const { id, participants, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  const started = await connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Game did not start");
  connections[1].close();
  connections[2].close();
  await expectPending(id, participants[1].playerId);
  await expectPending(id, participants[2].playerId);
  await expirePlayers(id, [participants[1].playerId, participants[2].playerId]);
  const updated = await getRoom(id);
  if (updated.status === "waiting") throw new Error("Game did not start");
  expect(updated.game.eliminatedColors).toEqual([
    started.players[1].color,
    started.players[2].color,
  ]);
});

test("開始・着手・再取得で時計の基準時刻と期限を維持する", async () => {
  const { id, connections, room } = await startFourPlayerRoom();
  expect(room.clock.remainingMainMs).toEqual({
    black: 300_000,
    white: 300_000,
    red: 300_000,
    blue: 300_000,
  });
  expect(room.clock.turnExpiresAt - room.clock.turnStartedAt).toBe(330_000);
  const fetched = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${getRoomContract.pathFor(id)}`),
  );
  const getPayload = getRoomContract.response.parse(await fetched.json());
  expect(getPayload.room).toEqual(room);
  expect(getPayload.serverNowMs).toBeGreaterThanOrEqual(room.clock.turnStartedAt);
  const reconnected = await openRoom(id);
  const snapshot = reconnected.initialSnapshot;
  if (snapshot === null) throw new Error("Room snapshot missing");
  expect(snapshot.room).toEqual(room);
  expect(snapshot.serverNowMs).toBeGreaterThanOrEqual(getPayload.serverNowMs);

  const black = room.players.findIndex((player) => player.color === "black");
  connections[black].send({
    type: "room.game.action",
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    action: { type: "placeStone", position: { x: 2, y: 3 } },
  });
  const moved = await connections[0].nextSnapshotWhere(
    (next) => next.status === "playing" && next.game.moveNumber === 1,
  );
  if (moved.status !== "playing") throw new Error("Game did not continue");
  expect(moved.clock.remainingMainMs.black).toBeLessThanOrEqual(300_000);
  expect(moved.clock.turnStartedAt).toBeGreaterThanOrEqual(room.clock.turnStartedAt);
  expect(moved.clock.turnExpiresAt - moved.clock.turnStartedAt).toBe(330_000);
  expect(await getRoom(id)).toEqual(moved);
  await runInDurableObject(env.GAME_ROOM.getByName(id), (_instance, state) => {
    const replay = roundReplaySchema.parse(state.storage.kv.get("round-replay"));
    expect(replay.steps.at(-1)?.action).toMatchObject({ type: "place", color: "black" });
    if (moved.status === "playing") expect(replay.steps.at(-1)?.game).toEqual(moved.game);
  });
});

test("期限到達後の着手を拒否し、時間切れを全接続へ配信する", async () => {
  const { id, connections, participants, room } = await startFourPlayerRoom();
  const black = room.players.findIndex((player) => player.color === "black");
  await setRoomDeadlines(id, (current) => ({
    ...current,
    clock: {
      ...current.clock,
      remainingMainMs: { ...current.clock.remainingMainMs, black: 0 },
      turnStartedAt: Date.now() - 30_001,
      turnExpiresAt: Date.now() - 1,
    },
  }));
  connections[black].send({
    type: "room.game.action",
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    action: { type: "placeStone", position: { x: 2, y: 3 } },
  });
  const updated = await connections[0].nextSnapshotWhere(
    (next) => next.status !== "waiting" && next.game.eliminatedColors.includes("black"),
  );
  expect(updated.status).toBe("playing");
  if (updated.status !== "playing") throw new Error("Game ended too soon");
  expect(updated.game.moveNumber).toBe(0);
  expect(updated.game.turn).not.toBe("black");
  expect(updated.clock.remainingMainMs.black).toBe(0);
  expect(updated.clock.turnStartedAt).toBe(updated.clock.turnExpiresAt - 330_000);
  for (const connection of connections.slice(1)) {
    expect(
      await connection.nextSnapshotWhere(
        (next) => next.status !== "waiting" && next.game.eliminatedColors.includes("black"),
      ),
    ).toEqual(updated);
  }
  expect(await getRoom(id)).toEqual(updated);
  expect((await getMembership(id, participants[black].token)).status).toBe(200);
  expect((await connections[black].nextType("room.error")).error).toBe("stale_position");
});

test("同時刻の時計切れを復帰期限より先に処理する", async () => {
  const { id, connections, participants, room } = await startFourPlayerRoom();
  const other = room.players.findIndex((player) => player.color !== "black");
  connections[other].close();
  await expectPending(id, participants[other].playerId);
  const deadline = Date.now() - 1;
  await setRoomDeadlines(id, (current) => ({
    ...current,
    clock: {
      ...current.clock,
      remainingMainMs: { black: 0, white: 300_000, red: 300_000, blue: 300_000 },
      turnStartedAt: deadline - 30_000,
      turnExpiresAt: deadline,
    },
    players: current.players.map((player) =>
      player.kind === "human" && player.id === participants[other].playerId
        ? { ...player, reconnectDeadline: deadline }
        : player,
    ),
  }));
  expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
  const updated = await getRoom(id);
  if (updated.status === "waiting") throw new Error("Game did not start");
  expect(updated.game.eliminatedColors).toEqual(["black", room.players[other].color]);
});

test("復帰期限が時計より先なら、切断による脱落を先に処理する", async () => {
  const { id, connections, participants, room } = await startFourPlayerRoom();
  const other = room.players.findIndex((player) => player.color !== "black");
  connections[other].close();
  await expectPending(id, participants[other].playerId);
  const disconnectDeadline = Date.now() - 2;
  await setRoomDeadlines(id, (current) => ({
    ...current,
    clock: {
      ...current.clock,
      remainingMainMs: { ...current.clock.remainingMainMs, black: 0 },
      turnStartedAt: disconnectDeadline - 29_999,
      turnExpiresAt: disconnectDeadline + 1,
    },
    players: current.players.map((player) =>
      player.kind === "human" && player.id === participants[other].playerId
        ? { ...player, reconnectDeadline: disconnectDeadline }
        : player,
    ),
  }));
  expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
  const updated = await getRoom(id);
  if (updated.status === "waiting") throw new Error("Game did not start");
  expect(updated.game.eliminatedColors).toEqual([room.players[other].color, "black"]);
});

test("遅れたAlarmでも保存期限の順に連続時間切れを確定し、時計を止める", async () => {
  const { id, connections } = await startFourPlayerRoom();
  const deadline = Date.now() - 90_001;
  await setRoomDeadlines(id, (room) => ({
    ...room,
    clock: {
      remainingMainMs: { black: 0, white: 0, red: 0, blue: 0 },
      turnStartedAt: deadline - 30_000,
      turnExpiresAt: deadline,
    },
  }));
  expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
  const result = await getRoom(id);
  expect(result.status).toBe("waiting");
  if (result.status !== "waiting") throw new Error("Game did not finish");
  expect(result.lastRound?.game.eliminatedColors).toEqual(["black", "white", "red"]);
  expect(result.clock).toBeNull();
  for (const connection of connections) {
    expect(
      await connection.nextSnapshotWhere(
        (room) => room.status === "waiting" && room.lastRound !== null,
      ),
    ).toEqual(result);
  }
});
