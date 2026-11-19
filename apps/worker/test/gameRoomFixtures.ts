import { AcceptedGameRequest } from "./acceptedGameRequest";
import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  createRoomContract,
  getRoomContract,
  getRoomMembershipContract,
  joinRoomContract,
  leaveRoomContract,
  listRoomsContract,
  fourReversiRoomSchema as roomSchema,
  roomSocketContract,
  type FourReversiRoom as Room,
  type RoomMode,
  type RoomTimeControl,
  type RoomPublicMetadata,
  type RoomSocketClientMessage,
  type RoomSocketMessage as ProtocolRoomSocketMessage,
} from "@tetraboard/protocol";
import { afterEach, expect, vi } from "vitest";

type RoomSocketMessage =
  | Exclude<ProtocolRoomSocketMessage, { type: "room.snapshot" }>
  | (Omit<Extract<ProtocolRoomSocketMessage, { type: "room.snapshot" }>, "room"> & { room: Room });

function parseReversiMessage(value: unknown): RoomSocketMessage {
  const message = roomSocketContract.message.parse(value);
  return message.type === "room.snapshot"
    ? { ...message, room: roomSchema.parse(message.room) }
    : message;
}

export const baseUrl = "https://example.com";

const clients: RoomClient[] = [];

class RoomClient {
  private readonly messages: RoomSocketMessage[] = [];
  private readonly waiters: ((message: RoomSocketMessage) => void)[] = [];
  initialSnapshot: Extract<RoomSocketMessage, { type: "room.snapshot" }> | null = null;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = parseReversiMessage(JSON.parse(String(event.data)));
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.messages.push(message);
    });
    socket.accept();
  }

  send(message: RoomSocketClientMessage): void {
    this.sendRaw(roomSocketContract.clientMessage.parse(message));
  }

  sendRaw(message: unknown): void {
    this.socket.send(JSON.stringify(message));
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

  async nextChatWhere(
    predicate: (
      messages: Extract<RoomSocketMessage, { type: "room.chat.snapshot" }>["messages"],
    ) => boolean,
  ) {
    for (;;) {
      const message = await this.nextType("room.chat.snapshot");
      if (predicate(message.messages)) return message.messages;
    }
  }

  close(): void {
    this.socket.close(1000, "test complete");
  }
}

export async function createRoom(
  quickPlay = false,
  mode: RoomMode = "singles",
  timeControl?: RoomTimeControl,
) {
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${createRoomContract.path}`, {
      method: createRoomContract.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ホスト", quickPlay, mode, timeControl }),
    }),
  );
  expect(response.status).toBe(201);
  const result = createRoomContract.response.parse(await response.json());
  return {
    ...result,
    room: roomSchema.parse({ ...result.room, roundId: null, positionRevision: 0 }),
  };
}

export async function joinRoom(id: string, name: string) {
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${joinRoomContract.pathFor(id)}`, {
      method: joinRoomContract.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
  expect(response.status).toBe(200);
  const result = joinRoomContract.response.parse(await response.json());
  return {
    ...result,
    room: roomSchema.parse({ ...result.room, roundId: null, positionRevision: 0 }),
  };
}

export async function getRoom(id: string): Promise<Room> {
  const response = await exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${getRoomContract.pathFor(id)}`),
  );
  expect(response.status).toBe(200);
  return roomSchema.parse(getRoomContract.response.parse(await response.json()).room);
}

export async function getMetadata(id: string): Promise<RoomPublicMetadata | null> {
  return env.GAME_ROOM.getByName(id).getPublicMetadata();
}

export async function listRooms(cursor?: string) {
  const path = cursor
    ? `${listRoomsContract.path}?cursor=${encodeURIComponent(cursor)}`
    : listRoomsContract.path;
  const response = await exports.default.fetch(new AcceptedGameRequest(`${baseUrl}${path}`));
  expect(response.status).toBe(200);
  return listRoomsContract.response.parse(await response.json());
}

export async function indexedRoom(id: string): Promise<{
  revision: number;
  closed: number;
  status: string;
  host_name: string | null;
  updated_at_ms: number;
} | null> {
  return env.APP_DB.prepare(
    "SELECT revision, closed, status, host_name, updated_at_ms FROM room_index WHERE room_id = ?",
  )
    .bind(id)
    .first();
}

export async function waitForIndexedRoom(
  id: string,
  predicate: (row: NonNullable<Awaited<ReturnType<typeof indexedRoom>>>) => boolean,
) {
  await vi.waitFor(async () => {
    const row = await indexedRoom(id);
    expect(row !== null && predicate(row)).toBe(true);
  });
  return (await indexedRoom(id))!;
}

export async function leaveRoom(id: string, token: string): Promise<Response> {
  return exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${leaveRoomContract.pathFor(id)}`, {
      method: leaveRoomContract.method,
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function getMembership(id: string, token: string): Promise<Response> {
  return exports.default.fetch(
    new AcceptedGameRequest(`${baseUrl}${getRoomMembershipContract.pathFor(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
}

export async function expectPending(id: string, playerId: string): Promise<void> {
  await vi.waitFor(async () => {
    const room = await getRoom(id);
    expect(typeof room.players.find((player) => player.id === playerId)?.reconnectDeadline).toBe(
      "number",
    );
  });
}

export async function expirePlayers(id: string, playerIds: string[]): Promise<void> {
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

export async function openRoom(id: string): Promise<RoomClient> {
  const response = await env.GAME_ROOM.getByName(id).fetch(
    new AcceptedGameRequest(`${baseUrl}${roomSocketContract.pathFor(id)}`, {
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

export async function authenticatedRoom(id: string, token: string): Promise<RoomClient> {
  const client = await openRoom(id);
  client.send({ type: "room.auth", token });
  await client.nextType("room.authenticated");
  return client;
}

export async function fourPlayers(timeControl?: RoomTimeControl) {
  const created = await createRoom(false, "singles", timeControl);
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

export async function readyPlayers(id: string, connections: RoomClient[]): Promise<void> {
  for (let index = 0; index < connections.length; index++) {
    connections[index].send({ type: "room.ready.set", ready: true });
    await connections[0].nextSnapshotWhere(
      (room) => room.players.filter((player) => player.ready).length === index + 1,
    );
  }
  expect((await getRoom(id)).players.every((player) => player.ready)).toBe(true);
}

export async function startFourPlayerRoom() {
  const setup = await fourPlayers();
  await readyPlayers(setup.id, setup.connections);
  setup.connections[0].send({ type: "room.game.start" });
  const room = await setup.connections[0].nextSnapshotWhere(
    (snapshot) => snapshot.status === "playing",
  );
  if (room.status !== "playing") throw new Error("Game did not start");
  return { ...setup, room };
}

export async function setRoomDeadlines(
  id: string,
  change: (room: Extract<Room, { status: "playing" }>) => Room,
): Promise<void> {
  await runInDurableObject(env.GAME_ROOM.getByName(id), (_instance, state) => {
    const room = roomSchema.parse(state.storage.kv.get("room"));
    if (room.status !== "playing") throw new Error("Game did not start");
    state.storage.kv.put("room", roomSchema.parse(change(room)));
  });
}

export function registerGameRoomFixtures() {
  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });
}
