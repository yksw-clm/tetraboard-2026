import { env, exports } from "cloudflare:workers";
import {
  createRoomContract,
  getRoomContract,
  joinRoomContract,
  roomSocketContract,
  type Room,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import { getLegalMoves } from "@tetraboard/four-reversi";
import { afterEach, expect, test } from "vitest";

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
