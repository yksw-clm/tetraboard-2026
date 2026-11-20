import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  getRoomContract,
  getRoomMembershipContract,
  fourReversiRoomSchema as roomSchema,
  roundReplaySchema,
} from "@tetraboard/protocol";
import { expect, test, vi } from "vitest";
import {
  registerGameRoomFixtures,
  createRoom,
  baseUrl,
  waitForIndexedRoom,
  authenticatedRoom,
  leaveRoom,
  fourPlayers,
  readyPlayers,
  getMembership,
  getRoom,
  expirePlayers,
} from "./gameRoomFixtures";

registerGameRoomFixtures();

test("24時間の活動停止でルームを閉鎖し、索引から除外する", async () => {
  const created = await createRoom();
  const stub = env.GAME_ROOM.getByName(created.room.id);
  await runInDurableObject(stub, (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(
      "room",
      roomSchema.parse({ ...room, lastActivityAtMs: Date.now() - 24 * 60 * 60 * 1000 - 1 }),
    );
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(
    (
      await exports.default.fetch(
        new AcceptedGameRequest(`${baseUrl}${getRoomContract.pathFor(created.room.id)}`),
      )
    ).status,
  ).toBe(404);
  await waitForIndexedRoom(created.room.id, (row) => row.closed === 1);
});

test("対局終了時に人間が残っていなければ部屋を閉鎖する", async () => {
  const created = await createRoom(true, "doubles");
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  host.send({ type: "room.game.start" });
  await host.nextSnapshotWhere((room) => room.status === "playing");
  expect((await leaveRoom(created.room.id, created.membership.token)).status).toBe(204);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${getRoomContract.pathFor(created.room.id)}`),
  );
  expect(response.status).toBe(404);
  await waitForIndexedRoom(created.room.id, (row) => row.closed === 1);
});

test("終局後は自動で再戦待機になり、ホストを引き継いで次局を開始できる", async () => {
  const setup = await fourPlayers();
  setup.connections[0].send({ type: "room.mode.set", mode: "doubles" });
  await setup.connections[0].nextSnapshotWhere((room) => room.settings.mode === "doubles");
  await readyPlayers(setup.id, setup.connections);
  setup.connections[0].send({ type: "room.game.start" });
  await setup.connections[0].nextSnapshotWhere((room) => room.status === "playing");
  expect((await leaveRoom(setup.id, setup.participants[0].token)).status).toBe(204);
  const waiting = await setup.connections[1].nextSnapshotWhere(
    (room) => room.status === "waiting" && room.lastRound !== null,
  );
  if (waiting.status !== "waiting") throw new Error("Rematch waiting state missing");
  expect(waiting.players).toHaveLength(3);
  expect(waiting.players.every((player) => player.kind === "cpu" || !player.ready)).toBe(true);
  expect(waiting.lastRound?.players).toHaveLength(4);
  expect(waiting.lastRound?.replay?.steps.at(-1)?.action).toMatchObject({
    type: "eliminate",
    reason: "left",
  });
  const promoted = getRoomMembershipContract.response.parse(
    await (await getMembership(setup.id, setup.participants[1].token)).json(),
  );
  expect(promoted.role).toBe("host");
  setup.connections[1].send({ type: "room.cpu.add", level: 1 });
  await setup.connections[1].nextSnapshotWhere(
    (room) => room.players.length === 4 && room.status === "waiting",
  );
  for (const connection of setup.connections.slice(1))
    connection.send({ type: "room.ready.set", ready: true });
  await setup.connections[1].nextSnapshotWhere((room) =>
    room.players.every((player) => player.ready),
  );
  setup.connections[1].send({ type: "room.game.start" });
  const restarted = await setup.connections[1].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.moveNumber === 0,
  );
  expect(restarted.lastRound).toBeNull();
  expect(waiting.eliminations).toEqual([]);
  expect(restarted.eliminations).toEqual([]);
  await runInDurableObject(env.GAME_ROOM.getByName(setup.id), (_instance, state) => {
    const replay = roundReplaySchema.parse(state.storage.kv.get("round-replay"));
    expect(replay.id).not.toBe(waiting.lastRound?.replay?.id);
    expect(replay.steps).toEqual([]);
  });
  expect(new Set(restarted.players.map((player) => player.color)).size).toBe(4);
});

test("再戦では切断からの元の30秒期限を引き継ぐ", async () => {
  const setup = await fourPlayers();
  setup.connections[0].send({ type: "room.mode.set", mode: "doubles" });
  await setup.connections[0].nextSnapshotWhere((room) => room.settings.mode === "doubles");
  await readyPlayers(setup.id, setup.connections);
  setup.connections[0].send({ type: "room.game.start" });
  await setup.connections[0].nextSnapshotWhere((room) => room.status === "playing");
  setup.connections[3].close();
  await vi.waitFor(async () => {
    expect(
      (await getRoom(setup.id)).players.find(
        (player) => player.id === setup.participants[3].playerId,
      )?.reconnectDeadline,
    ).not.toBeNull();
  });
  const deadline = (await getRoom(setup.id)).players.find(
    (player) => player.id === setup.participants[3].playerId,
  )?.reconnectDeadline;
  expect((await leaveRoom(setup.id, setup.participants[1].token)).status).toBe(204);
  const waiting = await getRoom(setup.id);
  expect(waiting.status).toBe("waiting");
  expect(
    waiting.players.find((player) => player.id === setup.participants[3].playerId)
      ?.reconnectDeadline,
  ).toBe(deadline);
  await expirePlayers(setup.id, [setup.participants[3].playerId]);
  expect(
    (await getRoom(setup.id)).players.some(
      (player) => player.id === setup.participants[3].playerId,
    ),
  ).toBe(false);
});
