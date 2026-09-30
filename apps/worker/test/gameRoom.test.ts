import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  createRoomContract,
  getRoomContract,
  getRoomMembershipContract,
  joinRoomContract,
  leaveRoomContract,
  roomSchema,
  roomSocketContract,
  type Room,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/four-reversi";
import { afterEach, expect, test, vi } from "vitest";

const baseUrl = "https://example.com";
const clients: RoomClient[] = [];

class RoomClient {
  private readonly messages: RoomSocketMessage[] = [];
  private readonly waiters: ((message: RoomSocketMessage) => void)[] = [];

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = roomSocketContract.message.parse(JSON.parse(String(event.data)));
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
    socket.accept();
  }

  send(message: RoomSocketClientMessage): void {
    this.socket.send(JSON.stringify(roomSocketContract.clientMessage.parse(message)));
  }

  private next(): Promise<RoomSocketMessage> {
    const queued = this.messages.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve, reject) => {
      const receive = (message: RoomSocketMessage) => {
        clearTimeout(timeout);
        resolve(message);
      };
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(receive);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Timed out waiting for a room message"));
      }, 5_000);
      this.waiters.push(receive);
    });
  }

  async nextType<T extends RoomSocketMessage["type"]>(
    type: T,
  ): Promise<Extract<RoomSocketMessage, { type: T }>> {
    for (;;) {
      const message = await this.next();
      if (message.type === type) return message as Extract<RoomSocketMessage, { type: T }>;
    }
  }

  async nextSnapshotWhere(predicate: (room: Room) => boolean): Promise<Room> {
    for (;;) {
      const message = await this.nextType("room.snapshot");
      if (predicate(message.room)) return message.room;
    }
  }

  close(): void {
    this.socket.close(1000, "test complete");
  }
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

async function createRoom() {
  const response = await exports.default.fetch(
    new Request(`${baseUrl}${createRoomContract.path}`, {
      method: createRoomContract.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ホスト" }),
    }),
  );
  expect(response.status).toBe(201);
  return createRoomContract.response.parse(await response.json());
}

async function joinRoom(id: string, name: string) {
  const response = await exports.default.fetch(
    new Request(`${baseUrl}${joinRoomContract.pathFor(id)}`, {
      method: joinRoomContract.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  expect(response.status).toBe(200);
  return joinRoomContract.response.parse(await response.json());
}

async function getRoom(id: string): Promise<Room> {
  const response = await exports.default.fetch(
    new Request(`${baseUrl}${getRoomContract.pathFor(id)}`),
  );
  expect(response.status).toBe(200);
  return getRoomContract.response.parse(await response.json());
}

async function leaveRoom(id: string, token: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`${baseUrl}${leaveRoomContract.pathFor(id)}`, {
      method: leaveRoomContract.method,
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

async function getMembership(id: string, token: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`${baseUrl}${getRoomMembershipContract.pathFor(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

async function expectPending(id: string, playerId: string): Promise<void> {
  await vi.waitFor(async () => {
    const room = await getRoom(id);
    expect(typeof room.players.find((player) => player.id === playerId)?.reconnectDeadline).toBe(
      "number",
    );
  });
}

async function expirePlayers(id: string, playerIds: string[]): Promise<void> {
  const stub = env.GAME_ROOM.getByName(id);
  const deadline = Date.now() - 1;
  await runInDurableObject(stub, (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    state.storage.kv.put(
      "room",
      roomSchema.parse({
        ...room,
        players: room.players.map((player) =>
          playerIds.includes(player.id) ? { ...player, reconnectDeadline: deadline } : player,
        ),
      }),
    );
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

async function openRoom(id: string): Promise<RoomClient> {
  const response = await env.GAME_ROOM.getByName(id).fetch(
    new Request(`${baseUrl}${roomSocketContract.pathFor(id)}`, {
      headers: { Upgrade: "websocket" },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("WebSocket upgrade failed");
  const client = new RoomClient(socket);
  clients.push(client);
  await client.nextType("room.snapshot");
  return client;
}

async function authenticatedRoom(id: string, token: string): Promise<RoomClient> {
  const client = await openRoom(id);
  client.send({ type: "room.auth", token });
  await client.nextType("room.authenticated");
  return client;
}

async function fourPlayers() {
  const created = await createRoom();
  const id = created.room.id;
  const participants = [created.membership];
  for (let index = 2; index <= 4; index++) {
    participants.push((await joinRoom(id, `参加者${index}`)).membership);
  }
  const connections = await Promise.all(
    participants.map((participant) => authenticatedRoom(id, participant.token)),
  );
  return { id, participants, connections };
}

async function readyPlayers(id: string, connections: RoomClient[]): Promise<void> {
  for (let index = 0; index < connections.length; index++) {
    connections[index].send({ type: "room.ready.set", ready: true });
    await connections[0].nextSnapshotWhere(
      (room) => room.players.filter((player) => player.ready).length === index + 1,
    );
  }
  expect((await getRoom(id)).players.every((player) => player.ready)).toBe(true);
}

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
    action: { type: "placeStone", position: { x: 2, y: 3 } },
  } as const;

  connections[otherIndex].send(validMove);
  expect((await connections[otherIndex].nextType("room.error")).error).toBe("not_your_turn");
  expect(await getRoom(id)).toEqual(started);

  connections[blackIndex].send({
    type: "room.game.action",
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
    expect(updated.game.board[3][2]).toBe("black");
    expect(updated.game.board[3][3]).toBe("black");
    expect(updated.game.turn).toBe("white");
  }
});

test("終局したルームを保存・配信し、以後の着手を拒否する", async () => {
  const { id, connections } = await fourPlayers();
  await readyPlayers(id, connections);
  connections[0].send({ type: "room.game.start" });
  let room = await connections[0].nextSnapshotWhere((snapshot) => snapshot.status === "playing");

  for (let move = 0; move < 64 && room.status === "playing"; move++) {
    const turn = room.game.turn;
    const playerIndex = room.players.findIndex((player) => player.color === turn);
    const [position] = getLegalMoves(room.game);
    expect(playerIndex).toBeGreaterThanOrEqual(0);
    expect(position).toBeDefined();
    const previousMoveNumber = room.game.moveNumber;
    connections[playerIndex].send({
      type: "room.game.action",
      action: { type: "placeStone", position },
    });
    room = await connections[0].nextSnapshotWhere(
      (snapshot) => snapshot.status !== "waiting" && snapshot.game.moveNumber > previousMoveNumber,
    );
  }

  expect(room.status).toBe("finished");
  if (room.status !== "finished") return;
  expect(room.game.status).toBe("finished");
  expect(room.game.result.mode).toBe("singles");
  for (const connection of connections.slice(1)) {
    expect(
      await connection.nextSnapshotWhere((snapshot) => snapshot.status === "finished"),
    ).toEqual(room);
  }
  expect(await getRoom(id)).toEqual(room);

  connections[0].send({
    type: "room.game.action",
    action: { type: "placeStone", position: { x: 0, y: 0 } },
  });
  expect((await connections[0].nextType("room.error")).error).toBe("game_finished");
  expect(await getRoom(id)).toEqual(room);
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
    new Request(`${baseUrl}${getRoomContract.pathFor(created.room.id)}`),
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
    new Request(`${baseUrl}${getRoomContract.pathFor(created.room.id)}`),
  );
  expect(response.status).toBe(404);
  expect((await getMembership(created.room.id, created.membership.token)).status).toBe(404);
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
  if (updated.status === "playing") expect(updated.game.eliminatedColors).toContain(color);
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
