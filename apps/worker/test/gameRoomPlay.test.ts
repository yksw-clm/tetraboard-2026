import { seedFourReversiEnd } from "./roomPositionFixtures";
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { type FourReversiRoom as Room } from "@tetraboard/protocol";
import { applyAction, createInitialState, getLegalMoves } from "@tetraboard/four-reversi";
import { expect, test } from "vitest";
import {
  registerGameRoomFixtures,
  startFourPlayerRoom,
  openRoom,
  leaveRoom,
  expectPending,
  getRoom,
  expirePlayers,
  setRoomDeadlines,
  fourPlayers,
  readyPlayers,
} from "./gameRoomFixtures";

registerGameRoomFixtures();

test.each(["resigned", "left", "timeout", "disconnected"] as const)(
  "脱落理由 %s を保存・配信し、再取得・途中観戦・旧データの復元で維持する",
  async (reason) => {
    const setup = await startFourPlayerRoom();
    const observer = await openRoom(setup.id);
    const black = setup.room.players.findIndex((player) => player.color === "black");
    const participant = setup.participants[black];
    if (reason === "resigned") setup.connections[black].send({ type: "room.game.resign" });
    else if (reason === "left") await leaveRoom(setup.id, participant.token);
    else if (reason === "disconnected") {
      setup.connections[black].close();
      await expectPending(setup.id, participant.playerId);
      expect((await getRoom(setup.id)).eliminations).toEqual([]);
      await expirePlayers(setup.id, [participant.playerId]);
    } else {
      await setRoomDeadlines(setup.id, (room) => ({
        ...room,
        clock: {
          ...room.clock,
          turnStartedAt: Date.now() - 330_001,
          turnExpiresAt: Date.now() - 1,
        },
      }));
      await runDurableObjectAlarm(env.GAME_ROOM.getByName(setup.id));
    }
    const expected = [{ color: "black", reason }];
    const snapshot = await observer.nextSnapshotWhere(
      (room) => room.status === "playing" && room.game.eliminatedColors.includes("black"),
    );
    expect(snapshot.eliminations).toEqual(expected);
    expect((await getRoom(setup.id)).eliminations).toEqual(expected);
    expect((await openRoom(setup.id)).initialSnapshot?.room.eliminations).toEqual(expected);
    await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_instance, state) => {
      const saved = state.storage.kv.get<Room>("room")!;
      expect(saved.eliminations).toEqual(expected);
      Reflect.deleteProperty(saved, "eliminations");
      state.storage.kv.delete("room-state-version");
      state.storage.kv.put("room", saved);
    });
    expect((await getRoom(setup.id)).eliminations).toEqual(expected);
    expect((await openRoom(setup.id)).initialSnapshot?.room.eliminations).toEqual(expected);
    await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_instance, state) => {
      state.storage.kv.delete("round-replay");
      const saved = state.storage.kv.get<Room>("room")!;
      Reflect.deleteProperty(saved, "eliminations");
      state.storage.kv.put("room", saved);
      state.storage.kv.delete("room-state-version");
    });
    const legacy = await getRoom(setup.id);
    expect(legacy.eliminations).toEqual([]);
    if (legacy.status !== "playing") throw new Error("Expected playing room");
    expect(legacy.game.eliminatedColors).toEqual(["black"]);
  },
);

test("投了・通信切れ・時間切れを順に記録し、終局後の再取得と観戦でも同じ棋譜を返す", async () => {
  const setup = await startFourPlayerRoom();
  const byColor = (color: string) =>
    setup.room.players.findIndex((player) => player.color === color);
  const observer = await openRoom(setup.id);
  setup.connections[byColor("black")].send({ type: "room.game.resign" });
  await observer.nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.turn === "white",
  );
  setup.connections[byColor("white")].close();
  const whiteId = setup.participants[byColor("white")].playerId;
  await expectPending(setup.id, whiteId);
  await expirePlayers(setup.id, [whiteId]);
  await observer.nextSnapshotWhere((room) => room.status === "playing" && room.game.turn === "red");
  await setRoomDeadlines(setup.id, (room) => ({
    ...room,
    clock: { ...room.clock, turnStartedAt: Date.now() - 330_001, turnExpiresAt: Date.now() - 1 },
  }));
  await runDurableObjectAlarm(env.GAME_ROOM.getByName(setup.id));
  const ended = await observer.nextSnapshotWhere(
    (room) => room.status === "waiting" && room.lastRound !== null,
  );
  const replay = ended.lastRound?.replay;
  expect(replay?.steps.map((step) => step.action)).toEqual([
    { type: "eliminate", color: "black", reason: "resigned" },
    { type: "eliminate", color: "white", reason: "disconnected" },
    { type: "eliminate", color: "red", reason: "timeout" },
  ]);
  expect(replay?.steps.at(-1)?.game).toEqual(ended.lastRound?.game);
  expect((await getRoom(setup.id)).lastRound).toEqual(ended.lastRound);
  expect((await openRoom(setup.id)).initialSnapshot?.room.lastRound).toEqual(ended.lastRound);
});

test("手番外と不正な着手は状態を変えず、合法手は保存・配信する", async () => {
  const { id, participants, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  const started = await connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Game did not start");

  const blackIndex = started.players.findIndex((player) => player.color === "black");
  const otherIndex = started.players.findIndex((player) => player.color !== "black");
  expect(started.players[blackIndex].id).toBe(participants[blackIndex].playerId);
  const validMove = {
    type: "room.game.action",
    roundId: started.roundId,
    positionRevision: started.positionRevision,
    action: { type: "placeStone", position: { x: 2, y: 3 } },
  } as const;

  connections[otherIndex].send(validMove);
  expect((await connections[otherIndex].nextType("room.error")).error).toBe("not_your_turn");
  expect(await getRoom(id)).toEqual(started);

  connections[blackIndex].send({
    type: "room.game.action",
    roundId: started.roundId,
    positionRevision: started.positionRevision,
    action: { type: "placeStone", position: { x: 3, y: 4 } },
  });
  expect((await connections[blackIndex].nextType("room.error")).error).toBe("invalid_move");
  expect(await getRoom(id)).toEqual(started);

  connections[blackIndex].send(validMove);
  const updated = await connections[otherIndex].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.moveNumber === 1,
  );
  const senderView = await connections[blackIndex].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.moveNumber === 1,
  );
  expect(senderView).toEqual(updated);
  expect(await getRoom(id)).toEqual(updated);
  if (updated.status === "playing") {
    expect(updated.game.lastMove).toEqual({ x: 2, y: 3 });
    expect(updated.game.board[3][2]).toBe("black");
    expect(updated.game.board[3][3]).toBe("black");
    expect(updated.game.turn).toBe("white");
  }
});

test("自動パスを含む着手は版を一つ進め、終局したルームを保存・配信する", async () => {
  const { id, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  let room = await connections[0].nextSnapshotWhere((snapshot) => snapshot.status === "playing");

  room = await seedFourReversiEnd(env.GAME_ROOM.getByName(id), room, true);

  for (let move = 0; move < 64 && room.status === "playing"; move++) {
    const turn = room.game.turn;
    const playerIndex = room.players.findIndex((player) => player.color === turn);
    const [position] = getLegalMoves(room.game);
    expect(playerIndex).toBeGreaterThanOrEqual(0);
    expect(position).toBeDefined();
    const previousMoveNumber = room.game.moveNumber;
    const previousRevision = room.positionRevision;
    connections[playerIndex].send({
      type: "room.game.action",
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      action: { type: "placeStone", position },
    });
    room = await connections[0].nextSnapshotWhere((snapshot) =>
      snapshot.status === "playing"
        ? snapshot.game.moveNumber > previousMoveNumber
        : (snapshot.lastRound?.game.moveNumber ?? 0) > previousMoveNumber,
    );
    if (room.status === "playing") {
      expect(room.positionRevision).toBe(previousRevision + 1);
      if (move === 0) expect(room.game.consecutivePasses).toEqual(["black"]);
    }
  }

  expect(room.status).toBe("waiting");
  if (room.status !== "waiting") return;
  expect(room.roundId).toBeNull();
  expect(room.positionRevision).toBe(0);
  expect(room.lastRound?.game.status).toBe("finished");
  expect(room.lastRound?.game.result.mode).toBe("singles");
  const replay = room.lastRound?.replay;
  expect(replay).toBeTruthy();
  if (!replay) throw new Error("Replay missing");
  let replayed = createInitialState("singles");
  expect(replay.initial).toEqual(replayed);
  for (const step of replay.steps) {
    if (step.action.type !== "place") throw new Error("Unexpected elimination");
    expect(step.action.color).toBe(replayed.turn);
    const applied = applyAction(replayed, { type: "placeStone", position: step.action.position });
    if (!applied.ok) throw new Error("Recorded move is invalid");
    expect(step.game).toEqual(applied.state);
    expect(step.passedColors).toEqual(applied.passedColors);
    replayed = applied.state;
  }
  expect(replay.steps.some((step) => step.passedColors.length > 0)).toBe(true);
  expect(replayed).toEqual(room.lastRound?.game);
  for (const connection of connections.slice(1)) {
    expect(
      await connection.nextSnapshotWhere(
        (snapshot) => snapshot.status === "waiting" && snapshot.lastRound !== null,
      ),
    ).toEqual(room);
  }
  expect(await getRoom(id)).toEqual(room);

  connections[0].send({
    type: "room.game.action",
    roundId: replay.id,
    positionRevision: replay.steps.length,
    action: { type: "placeStone", position: { x: 0, y: 0 } },
  });
  expect((await connections[0].nextType("room.error")).error).toBe("game_finished");
  expect(await getRoom(id)).toEqual(room);
});
