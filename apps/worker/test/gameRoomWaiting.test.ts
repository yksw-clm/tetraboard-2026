import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  getRoomContract,
  getRoomMembershipContract,
  fourReversiRoomSchema as roomSchema,
} from "@tetraboard/protocol";
import { expect, test, vi } from "vitest";
import {
  registerGameRoomFixtures,
  createRoom,
  openRoom,
  getRoom,
  joinRoom,
  authenticatedRoom,
  readyPlayers,
  fourPlayers,
  leaveRoom,
  getMembership,
  baseUrl,
  expectPending,
  expirePlayers,
} from "./gameRoomFixtures";

registerGameRoomFixtures();

test("未認証の接続はReadyを変更できない", async () => {
  const created = await createRoom();
  const client = await openRoom(created.room.id);
  client.send({ type: "room.ready.set", ready: true });

  expect((await client.nextType("room.error")).error).toBe("unauthorized");
  expect(await getRoom(created.room.id)).toEqual(created.room);
});

test("3人全員がReadyでも開始できない", async () => {
  const created = await createRoom();
  const id = created.room.id;
  const joined = await Promise.all([joinRoom(id, "参加者2"), joinRoom(id, "参加者3")]);
  const connections = await Promise.all(
    [created.membership, ...joined.map((entry) => entry.membership)].map((participant) =>
      authenticatedRoom(id, participant.token),
    ),
  );
  await readyPlayers(id, connections);
  const waiting = await getRoom(id);

  connections[0].send({ type: "room.game.start" });
  expect((await connections[0].nextType("room.error")).error).toBe("not_ready");
  expect(await getRoom(id)).toEqual(waiting);
});

test("4人全員がReadyのときだけホストが開始できる", async () => {
  const { id, connections } = await fourPlayers();
  for (let index = 0; index < 3; index++) {
    connections[index].send({ type: "room.ready.set", ready: true });
    await connections[0].nextSnapshotWhere(
      (room) => room.players.filter((player) => player.ready).length === index + 1,
    );
  }
  const waiting = await getRoom(id);
  connections[0].send({ type: "room.game.start" });
  expect((await connections[0].nextType("room.error")).error).toBe("not_ready");
  expect(await getRoom(id)).toEqual(waiting);

  connections[3].send({ type: "room.ready.set", ready: true });
  await connections[0].nextSnapshotWhere((room) => room.players.every((player) => player.ready));
  connections[3].send({ type: "room.ready.set", ready: true });
  await connections[3].nextSnapshotWhere((room) => room.players.every((player) => player.ready));
  connections[1].send({ type: "room.game.start" });
  expect((await connections[1].nextType("room.error")).error).toBe("forbidden");
  expect((await getRoom(id)).status).toBe("waiting");

  connections[0].send({ type: "room.game.start" });
  const started = await connections[1].nextSnapshotWhere((room) => room.status === "playing");
  expect(started.status).toBe("playing");
  expect(new Set(started.players.map((player) => player.color)).size).toBe(4);
  if (started.status === "playing") {
    expect(started.game.mode).toBe("singles");
    expect(started.game.turn).toBe("black");
    expect(started.game.moveNumber).toBe(0);
  }
  expect(await getRoom(id)).toEqual(started);
});

test("待機中の退室で席と資格を解放し、最古の参加者へホストを引き継ぐ", async () => {
  const created = await createRoom();
  const joined = await joinRoom(created.room.id, "次のホスト");
  const successor = await authenticatedRoom(created.room.id, joined.membership.token);

  expect((await leaveRoom(created.room.id, created.membership.token)).status).toBe(204);
  const room = await getRoom(created.room.id);
  expect(room.players.map((player) => player.id)).toEqual([joined.membership.playerId]);
  expect((await getMembership(created.room.id, created.membership.token)).status).toBe(401);
  expect(
    getRoomMembershipContract.response.parse(
      await (await getMembership(created.room.id, joined.membership.token)).json(),
    ).role,
  ).toBe("host");
  expect((await successor.nextType("room.authenticated")).membership.role).toBe("host");
});

test("待機中の最後の退室でルームを閉鎖する", async () => {
  const created = await createRoom();
  expect((await leaveRoom(created.room.id, created.membership.token)).status).toBe(204);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${getRoomContract.pathFor(created.room.id)}`),
  );
  expect(response.status).toBe(404);
});

test("接続が欠ける間は開始できず、30秒以内の復帰で同じ席を使う", async () => {
  const { id, participants, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[3].close();
  await expectPending(id, participants[3].playerId);
  connections[0].send({ type: "room.game.start" });
  expect((await connections[0].nextType("room.error")).error).toBe("not_ready");

  await authenticatedRoom(id, participants[3].token);
  await vi.waitFor(async () => {
    const room = await getRoom(id);
    expect(room.players[3].reconnectDeadline).toBeNull();
    expect(room.players[3].ready).toBe(true);
  });
  connections[0].send({ type: "room.game.start" });
  expect((await connections[0].nextSnapshotWhere((room) => room.status === "playing")).status).toBe(
    "playing",
  );
});

test("同じ資格の別タブが接続中なら復帰期限を開始しない", async () => {
  const created = await createRoom();
  const first = await authenticatedRoom(created.room.id, created.membership.token);
  const second = await authenticatedRoom(created.room.id, created.membership.token);
  first.close();
  await vi.waitFor(async () => {
    expect((await getRoom(created.room.id)).players[0].reconnectDeadline).toBeNull();
  });
  second.close();
  await expectPending(created.room.id, created.membership.playerId);
});

test("切断通知を失っても次のアクセスで接続の欠落を検出する", async () => {
  const created = await createRoom();
  const client = await authenticatedRoom(created.room.id, created.membership.token);
  client.close();
  await expectPending(created.room.id, created.membership.playerId);
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(
      "room",
      roomSchema.parse({
        ...room,
        players: room.players.map((player) => ({ ...player, reconnectDeadline: null })),
      }),
    );
  });
  expect(typeof (await getRoom(created.room.id)).players[0].reconnectDeadline).toBe("number");
});

test("待機中の復帰期限切れで席を解放し、遅れたAlarmより先にGETで確定する", async () => {
  const created = await createRoom();
  const joined = await joinRoom(created.room.id, "参加者");
  const host = await authenticatedRoom(created.room.id, created.membership.token);
  const participant = await authenticatedRoom(created.room.id, joined.membership.token);
  participant.close();
  await expectPending(created.room.id, joined.membership.playerId);
  await runInDurableObject(env.GAME_ROOM.getByName(created.room.id), (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(
      "room",
      roomSchema.parse({
        ...room,
        players: room.players.map((player) =>
          player.id === joined.membership.playerId
            ? { ...player, reconnectDeadline: Date.now() - 1 }
            : player,
        ),
      }),
    );
  });
  expect((await getRoom(created.room.id)).players.map((player) => player.id)).toEqual([
    created.membership.playerId,
  ]);
  expect((await getMembership(created.room.id, joined.membership.token)).status).toBe(401);
  expect((await host.nextSnapshotWhere((room) => room.players.length === 1)).players).toHaveLength(
    1,
  );
});

test("期限後の認証では待機中の席を復帰させず、最後の席なら閉鎖する", async () => {
  const created = await createRoom();
  const client = await authenticatedRoom(created.room.id, created.membership.token);
  client.close();
  await expectPending(created.room.id, created.membership.playerId);
  await expirePlayers(created.room.id, [created.membership.playerId]);
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${getRoomContract.pathFor(created.room.id)}`),
  );
  expect(response.status).toBe(404);
  expect((await getMembership(created.room.id, created.membership.token)).status).toBe(404);
});
