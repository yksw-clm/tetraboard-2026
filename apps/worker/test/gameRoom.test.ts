import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  createRoomContract,
  getRoomContract,
  getRoomMembershipContract,
  joinRoomContract,
  leaveRoomContract,
  listRoomsContract,
  roomSchema,
  roomPublicMetadataSchema,
  roomSocketContract,
  roomTimeControl,
  type Room,
  type RoomMode,
  type RoomPublicMetadata,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/four-reversi";
import { afterEach, expect, test, vi } from "vitest";
import { writeRoomIndex } from "../src/rooms/roomIndex";

const baseUrl = "https://example.com";
const clients: RoomClient[] = [];

class RoomClient {
  private readonly messages: RoomSocketMessage[] = [];
  private readonly waiters: ((message: RoomSocketMessage) => void)[] = [];
  initialSnapshot: Extract<RoomSocketMessage, { type: "room.snapshot" }> | null = null;

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

async function createRoom(quickPlay = false, mode: RoomMode = "singles") {
  const response = await exports.default.fetch(
    new Request(`${baseUrl}${createRoomContract.path}`, {
      method: createRoomContract.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ホスト", quickPlay, mode }),
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
  return getRoomContract.response.parse(await response.json()).room;
}

async function getMetadata(id: string): Promise<RoomPublicMetadata | null> {
  return env.GAME_ROOM.getByName(id).getPublicMetadata();
}

async function listRooms(cursor?: string) {
  const path = cursor
    ? `${listRoomsContract.path}?cursor=${encodeURIComponent(cursor)}`
    : listRoomsContract.path;
  const response = await exports.default.fetch(new Request(`${baseUrl}${path}`));
  expect(response.status).toBe(200);
  return listRoomsContract.response.parse(await response.json());
}

async function indexedRoom(id: string): Promise<{
  revision: number;
  closed: number;
  status: string;
  host_name: string | null;
  updated_at_ms: number;
} | null> {
  return env.LOBBY_DB.prepare(
    "SELECT revision, closed, status, host_name, updated_at_ms FROM room_index WHERE room_id = ?",
  )
    .bind(id)
    .first();
}

async function waitForIndexedRoom(
  id: string,
  predicate: (row: NonNullable<Awaited<ReturnType<typeof indexedRoom>>>) => boolean,
) {
  await vi.waitFor(async () => {
    const row = await indexedRoom(id);
    expect(row !== null && predicate(row)).toBe(true);
  });
  return (await indexedRoom(id))!;
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
  client.initialSnapshot = await client.nextType("room.snapshot");
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

async function startFourPlayerRoom() {
  const setup = await fourPlayers();
  await readyPlayers(setup.id, setup.connections);
  setup.connections[0].send({ type: "room.game.start" });
  const room = await setup.connections[0].nextSnapshotWhere(
    (snapshot) => snapshot.status === "playing",
  );
  if (room.status !== "playing") throw new Error("Game did not start");
  return { ...setup, room };
}

async function setRoomDeadlines(
  id: string,
  change: (room: Extract<Room, { status: "playing" }>) => Room,
): Promise<void> {
  await runInDurableObject(env.GAME_ROOM.getByName(id), (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Game did not start");
    state.storage.kv.put("room", roomSchema.parse(change(room)));
  });
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
    new Request(`${baseUrl}${getRoomContract.pathFor(id)}`),
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
  expect((await connections[black].nextType("room.error")).error).toBe("already_eliminated");
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
  expect(result.status).toBe("finished");
  if (result.status !== "finished") throw new Error("Game did not finish");
  expect(result.game.eliminatedColors).toEqual(["black", "white", "red"]);
  expect(result.clock.turnStartedAt).toBeNull();
  expect(result.clock.turnExpiresAt).toBeNull();
  for (const connection of connections) {
    expect(await connection.nextSnapshotWhere((room) => room.status === "finished")).toEqual(
      result,
    );
  }
});

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

test("すぐ遊ぶは1人とCPU3体を作成し、CPU手番をDOが保存・配信する", async () => {
  const created = await createRoom(true);
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
      turnStartedAt: Date.now() - 501,
      turnExpiresAt: Date.now() + 329_499,
    },
  }));
  expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
  const moved = await host.nextSnapshotWhere(
    (snapshot) => snapshot.status !== "waiting" && snapshot.game.moveNumber > before,
  );
  expect(moved.status).not.toBe("waiting");
  expect(await getRoom(id)).toEqual(moved);
});

test("対局中に最後の人間が退室してもCPUは着手を続ける", async () => {
  const created = await createRoom(true);
  const id = created.room.id;
  const host = await authenticatedRoom(id, created.membership.token);
  const observer = await openRoom(id);
  host.send({ type: "room.game.start" });
  await observer.nextSnapshotWhere((room) => room.status === "playing");

  expect((await leaveRoom(id, created.membership.token)).status).toBe(204);
  const remaining = await observer.nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.eliminatedColors.length === 1,
  );
  if (remaining.status !== "playing") throw new Error("Game did not continue");
  const cpuTurn = remaining.game.turn;
  expect(remaining.players.find((player) => player.color === cpuTurn)?.kind).toBe("cpu");
  const before = remaining.game.moveNumber;
  await setRoomDeadlines(id, (room) => ({
    ...room,
    clock: {
      ...room.clock,
      turnStartedAt: Date.now() - 501,
      turnExpiresAt: Date.now() + 329_499,
    },
  }));
  expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
  const moved = await observer.nextSnapshotWhere(
    (room) => room.status !== "waiting" && room.game.moveNumber > before,
  );
  expect(await getRoom(id)).toEqual(moved);

  let completed = moved;
  for (let turn = 0; turn < 64 && completed.status === "playing"; turn++) {
    await setRoomDeadlines(id, (room) => ({
      ...room,
      clock: {
        ...room.clock,
        turnStartedAt: Date.now() - 501,
        turnExpiresAt: Date.now() + 300_000,
      },
    }));
    expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
    completed = await getRoom(id);
  }
  expect(completed.status).toBe("finished");
});

test("ルーム作成のモードは必須で、すぐ遊ぶにも選択したモードを保存する", async () => {
  for (const body of [
    { name: "ホスト", quickPlay: false },
    { name: "ホスト", quickPlay: false, mode: "other" },
  ]) {
    const response = await exports.default.fetch(
      new Request(`${baseUrl}${createRoomContract.path}`, {
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

test("公開メタデータは参加・CPU席・ホスト交代を反映し、閉鎖時は消える", async () => {
  const created = await createRoom();
  const id = created.room.id;
  const initial = await getMetadata(id);
  expect(initial).toEqual({
    id,
    game: "four-reversi",
    mode: "singles",
    timeControl: roomTimeControl,
    status: "waiting",
    hostName: "ホスト",
    humanCount: 1,
    cpuCount: 0,
    capacity: 4,
    openSeats: 3,
    updatedAtMs: created.room.publicUpdatedAtMs,
  });
  expect(roomPublicMetadataSchema.safeParse({ ...initial, openSeats: 0 }).success).toBe(false);

  const joined = await joinRoom(id, "二人目");
  const afterJoin = await getMetadata(id);
  expect(afterJoin?.humanCount).toBe(2);
  expect(afterJoin?.openSeats).toBe(2);
  expect(afterJoin!.updatedAtMs).toBeGreaterThan(initial!.updatedAtMs);

  const host = await authenticatedRoom(id, created.membership.token);
  const guest = await authenticatedRoom(id, joined.membership.token);
  host.send({ type: "room.cpu.add", level: 1 });
  await host.nextSnapshotWhere((room) => room.players.length === 3);
  const afterCpu = await getMetadata(id);
  expect(afterCpu?.cpuCount).toBe(1);
  expect(afterCpu?.openSeats).toBe(1);
  expect(afterCpu!.updatedAtMs).toBeGreaterThan(afterJoin!.updatedAtMs);
  await waitForIndexedRoom(id, (row) => row.updated_at_ms === afterCpu!.updatedAtMs);
  expect((await listRooms()).rooms.find((room) => room.id === id)?.cpuCount).toBe(1);

  const cpu = (await getRoom(id)).players.find((player) => player.kind === "cpu");
  if (cpu?.kind !== "cpu") throw new Error("CPU was not added");
  host.send({ type: "room.cpu.level.set", playerId: cpu.id, level: 2 });
  await host.nextSnapshotWhere((room) =>
    room.players.some(
      (player) => player.id === cpu.id && player.kind === "cpu" && player.level === 2,
    ),
  );
  const afterLevel = await getMetadata(id);
  expect(afterLevel?.cpuCount).toBe(1);
  expect(afterLevel!.updatedAtMs).toBeGreaterThan(afterCpu!.updatedAtMs);

  expect((await leaveRoom(id, created.membership.token)).status).toBe(204);
  await guest.nextSnapshotWhere((room) => room.players[0]?.name === "二人目");
  const afterHandoff = await getMetadata(id);
  expect(afterHandoff?.hostName).toBe("二人目");
  expect(afterHandoff?.humanCount).toBe(1);
  expect(afterHandoff?.cpuCount).toBe(1);
  expect(afterHandoff!.updatedAtMs).toBeGreaterThan(afterLevel!.updatedAtMs);

  guest.send({ type: "room.cpu.remove", playerId: cpu.id });
  await guest.nextSnapshotWhere((room) => room.players.length === 1);
  const afterRemove = await getMetadata(id);
  expect(afterRemove?.cpuCount).toBe(0);
  expect(afterRemove?.openSeats).toBe(3);
  expect(afterRemove!.updatedAtMs).toBeGreaterThan(afterHandoff!.updatedAtMs);
  await waitForIndexedRoom(id, (row) => row.updated_at_ms === afterRemove!.updatedAtMs);
  expect((await listRooms()).rooms.find((room) => room.id === id)?.cpuCount).toBe(0);

  expect((await leaveRoom(id, joined.membership.token)).status).toBe(204);
  expect(await getMetadata(id)).toBeNull();
});

test("ダブルス開始と終局は公開情報を更新し、通常の着手は更新しない", async () => {
  const setup = await fourPlayers();
  setup.connections[0].send({ type: "room.mode.set", mode: "doubles" });
  await setup.connections[0].nextSnapshotWhere((room) => room.settings.mode === "doubles");
  await readyPlayers(setup.id, setup.connections);
  const waiting = await getMetadata(setup.id);

  setup.connections[0].send({ type: "room.game.start" });
  const started = await setup.connections[0].nextSnapshotWhere((room) => room.status === "playing");
  if (started.status !== "playing") throw new Error("Game did not start");
  expect(started.game.mode).toBe("doubles");
  expect(
    roomSchema.safeParse({ ...started, settings: { ...started.settings, mode: "singles" } })
      .success,
  ).toBe(false);
  expect(new Set(started.players.map((player) => player.color)).size).toBe(4);
  const playing = await getMetadata(setup.id);
  expect(playing?.status).toBe("playing");
  expect(playing?.openSeats).toBe(0);
  expect(playing!.updatedAtMs).toBeGreaterThan(waiting!.updatedAtMs);
  const indexedBeforeMove = await waitForIndexedRoom(
    setup.id,
    (row) => row.status === "playing" && row.updated_at_ms === playing!.updatedAtMs,
  );

  setup.connections[1].send({ type: "room.mode.set", mode: "singles" });
  expect((await setup.connections[1].nextType("room.error")).error).toBe("already_started");

  const black = started.players.findIndex((player) => player.color === "black");
  setup.connections[black].send({
    type: "room.game.action",
    action: { type: "placeStone", position: getLegalMoves(started.game)[0] },
  });
  await setup.connections[0].nextSnapshotWhere(
    (room) => room.status === "playing" && room.game.moveNumber === 1,
  );
  expect((await getMetadata(setup.id))?.updatedAtMs).toBe(playing!.updatedAtMs);
  expect(await indexedRoom(setup.id)).toEqual(indexedBeforeMove);

  expect((await leaveRoom(setup.id, setup.participants[0].token)).status).toBe(204);
  const finished = await setup.connections[1].nextSnapshotWhere(
    (room) => room.status === "finished",
  );
  if (finished.status !== "finished" || finished.game.result.mode !== "doubles") {
    throw new Error("Doubles game did not finish");
  }
  expect(finished.game.result.reason).toBe("team_eliminated");
  const hostColor = finished.players.find(
    (player) => player.id === setup.participants[0].playerId,
  )?.color;
  expect(finished.game.result.winner).toBe(
    hostColor === "black" || hostColor === "red" ? "white-blue" : "black-red",
  );
  const metadata = await getMetadata(setup.id);
  expect(metadata?.status).toBe("finished");
  expect(metadata?.hostName).toBeNull();
  expect(metadata?.humanCount).toBe(4);
  expect(metadata!.updatedAtMs).toBeGreaterThan(playing!.updatedAtMs);
  await waitForIndexedRoom(setup.id, (row) => row.status === "finished");
});

test("D1の公開索引は作成・入室・ホスト交代・閉鎖を反映する", async () => {
  const created = await createRoom();
  const id = created.room.id;
  await waitForIndexedRoom(id, (row) => row.revision === 1 && row.closed === 0);
  expect((await listRooms()).rooms.some((room) => room.id === id)).toBe(true);

  const joined = await joinRoom(id, "二人目");
  await waitForIndexedRoom(id, (row) => row.revision === 2 && row.closed === 0);
  expect((await listRooms()).rooms.find((room) => room.id === id)?.humanCount).toBe(2);

  expect((await leaveRoom(id, created.membership.token)).status).toBe(204);
  await waitForIndexedRoom(id, (row) => row.revision === 3 && row.host_name === "二人目");
  expect((await listRooms()).rooms.find((room) => room.id === id)?.hostName).toBe("二人目");

  expect((await leaveRoom(id, joined.membership.token)).status).toBe(204);
  await waitForIndexedRoom(id, (row) => row.revision === 4 && row.closed === 1);
  expect((await listRooms()).rooms.some((room) => room.id === id)).toBe(false);
});

test("CPU席・モード・開始・終了は索引を更新し、通常の着手は更新しない", async () => {
  const created = await createRoom(true, "singles");
  const id = created.room.id;
  const host = await authenticatedRoom(id, created.membership.token);
  const initial = await waitForIndexedRoom(id, (row) => row.revision === 1);
  host.send({ type: "room.cpu.level.set", playerId: created.room.players[1].id, level: 2 });
  await host.nextSnapshotWhere(
    (room) => room.players[1].kind === "cpu" && room.players[1].level === 2,
  );
  await waitForIndexedRoom(id, (row) => row.revision > initial.revision);

  host.send({ type: "room.mode.set", mode: "doubles" });
  await host.nextSnapshotWhere((room) => room.settings.mode === "doubles");
  await vi.waitFor(async () => {
    expect((await listRooms()).rooms.find((room) => room.id === id)?.mode).toBe("doubles");
  });
  host.send({ type: "room.ready.set", ready: true });
  await host.nextSnapshotWhere((room) => room.players[0].ready);
  const beforeStart = await indexedRoom(id);
  host.send({ type: "room.game.start" });
  const playing = await host.nextSnapshotWhere((room) => room.status === "playing");
  if (playing.status !== "playing") throw new Error("Game did not start");
  await waitForIndexedRoom(
    id,
    (row) => row.revision > beforeStart!.revision && row.status === "playing",
  );

  const beforeMove = await indexedRoom(id);
  const black = playing.players.find((player) => player.color === "black");
  if (black?.kind === "human") {
    host.send({
      type: "room.game.action",
      action: { type: "placeStone", position: getLegalMoves(playing.game)[0] },
    });
    await host.nextSnapshotWhere((room) => room.status === "playing" && room.game.moveNumber === 1);
    expect(await indexedRoom(id)).toEqual(beforeMove);
  }

  expect((await leaveRoom(id, created.membership.token)).status).toBe(204);
  await waitForIndexedRoom(id, (row) => row.status === "finished" && row.host_name === null);
  expect((await listRooms()).rooms.find((room) => room.id === id)?.status).toBe("finished");
});

test("一覧は同じ更新時刻でも部屋番号順で20件ずつ取得し、不正カーソルを拒否する", async () => {
  const updatedAtMs = Date.now() + 1_000_000;
  const base: RoomPublicMetadata = {
    id: "99900",
    game: "four-reversi",
    mode: "singles",
    timeControl: roomTimeControl,
    status: "waiting",
    hostName: "テスト",
    humanCount: 1,
    cpuCount: 0,
    capacity: 4,
    openSeats: 3,
    updatedAtMs,
  };
  for (let index = 0; index < 22; index++) {
    await writeRoomIndex(env.LOBBY_DB, {
      metadata: { ...base, id: String(99900 + index) },
      revision: 1,
      closed: false,
      retryAtMs: 0,
    });
  }
  const first = await listRooms();
  expect(first.rooms).toHaveLength(20);
  expect(first.rooms.map((room) => room.id)).toEqual(
    Array.from({ length: 20 }, (_, index) => String(99921 - index)),
  );
  expect(first.nextCursor).toBe(`${updatedAtMs}:99902`);
  const second = await listRooms(first.nextCursor!);
  expect(second.rooms.slice(0, 2).map((room) => room.id)).toEqual(["99901", "99900"]);
  const invalid = await exports.default.fetch(
    new Request(`${baseUrl}${listRoomsContract.path}?cursor=invalid`),
  );
  expect(invalid.status).toBe(400);
});

test("古い索引更新は部屋番号再利用後の新しい更新を上書きしない", async () => {
  const created = await createRoom();
  const id = created.room.id;
  await waitForIndexedRoom(id, (row) => row.revision === 1);
  expect((await leaveRoom(id, created.membership.token)).status).toBe(204);
  await waitForIndexedRoom(id, (row) => row.revision === 2 && row.closed === 1);

  const replacement = roomSchema.parse({
    ...created.room,
    players: [{ ...created.room.players[0], id: crypto.randomUUID(), name: "新ホスト" }],
    publicUpdatedAtMs: Date.now(),
  });
  const newRoom = await env.GAME_ROOM.getByName(id).createRoom(replacement, "a".repeat(64));
  expect(newRoom?.players[0].name).toBe("新ホスト");
  await waitForIndexedRoom(id, (row) => row.revision === 3 && row.closed === 0);
  await writeRoomIndex(env.LOBBY_DB, {
    metadata: roomPublicMetadataSchema.parse({
      ...(await getMetadata(id)),
      hostName: "古いホスト",
    }),
    revision: 2,
    closed: true,
    retryAtMs: 0,
  });
  expect((await indexedRoom(id))?.host_name).toBe("新ホスト");
  expect((await indexedRoom(id))?.closed).toBe(0);
});

test("D1障害中も部屋を作成し、Alarmで索引反映を再試行する", async () => {
  await env.LOBBY_DB.exec("ALTER TABLE room_index RENAME TO room_index_unavailable");
  let created!: Awaited<ReturnType<typeof createRoom>>;
  try {
    created = await createRoom();
    await vi.waitFor(async () => {
      const pending = await runInDurableObject(
        env.GAME_ROOM.getByName(created.room.id),
        (_instance, state) => state.storage.kv.get<{ retryAtMs: number }>("room-index-pending"),
      );
      expect(pending?.retryAtMs).toBeGreaterThan(Date.now());
    });
  } finally {
    await env.LOBBY_DB.exec("ALTER TABLE room_index_unavailable RENAME TO room_index");
  }
  const stub = env.GAME_ROOM.getByName(created.room.id);
  await runInDurableObject(stub, async (_instance, state) => {
    const pending = state.storage.kv.get<{ retryAtMs: number }>("room-index-pending");
    if (!pending) throw new Error("Missing pending index update");
    state.storage.kv.put("room-index-pending", { ...pending, retryAtMs: Date.now() - 1 });
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await waitForIndexedRoom(created.room.id, (row) => row.closed === 0);
});
