import { AcceptedGameRequest } from "./acceptedGameRequest";
import { exports } from "cloudflare:workers";
import { afterEach, expect } from "vitest";
import { type Side } from "@tetraboard/four-shogi";
import {
  createRoomContract,
  joinRoomContract,
  getRoomContract,
  roomSocketContract,
  fourShogiRoomSchema,
  isFourShogiRoom,
  type FourShogiRoom,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
  type RoomTimeControl,
} from "@tetraboard/protocol";

const base = "https://example.com";

export const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new AcceptedGameRequest(base + path, init));

export const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const sockets: ShogiClient[] = [];

class ShogiClient {
  private messages: RoomSocketMessage[] = [];
  private receivers: ((message: RoomSocketMessage) => void)[] = [];
  constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = roomSocketContract.message.parse(JSON.parse(String(event.data)));
      const receiver = this.receivers.shift();
      if (receiver) receiver(message);
      else this.messages.push(message);
    });
    socket.accept();
    sockets.push(this);
  }
  send(message: RoomSocketClientMessage) {
    this.socket.send(JSON.stringify(message));
  }
  close() {
    this.socket.close();
  }
  private next(): Promise<RoomSocketMessage> {
    const queued = this.messages.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const receiver = (message: RoomSocketMessage) => {
        clearTimeout(timeout);
        resolve(message);
      };
      const timeout = setTimeout(() => {
        this.receivers = this.receivers.filter((entry) => entry !== receiver);
        reject(new Error("Shogi socket timed out"));
      }, 5000);
      this.receivers.push(receiver);
    });
  }
  async until(predicate: (message: RoomSocketMessage) => boolean) {
    for (;;) {
      const message = await this.next();
      if (predicate(message)) return message;
    }
  }
  async room(predicate: (room: FourShogiRoom) => boolean) {
    const message = await this.until(
      (message) =>
        message.type === "room.snapshot" &&
        isFourShogiRoom(message.room) &&
        predicate(message.room),
    );
    if (message.type !== "room.snapshot") throw new Error("No snapshot");
    return fourShogiRoomSchema.parse(message.room);
  }
  async error() {
    const message = await this.until((message) => message.type === "room.error");
    if (message.type !== "room.error") throw new Error("No error");
    return message.error;
  }
}

export async function connect(
  id: string,
  token?: string,
  formationAnalysis = false,
  eliminatedHands = false,
) {
  const response = await request(
    `/rooms/${id}/ws?${new URLSearchParams({ ...(formationAnalysis ? { formationAnalysis: "1" } : {}), ...(eliminatedHands ? { eliminatedHands: "1" } : {}) })}`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(response.status).toBe(101);
  const socket = new ShogiClient(response.webSocket!);
  if (token) {
    socket.send({ type: "room.auth", token });
    await socket.until((message) => message.type === "room.authenticated");
  }
  return socket;
}

export async function create(
  quickPlay = false,
  mode: "singles" | "doubles" = "singles",
  timeControl?: RoomTimeControl,
) {
  const response = await request(
    "/rooms",
    json({ name: "将棋ホスト", game: "four-shogi", quickPlay, mode, timeControl }),
  );
  expect(response.status).toBe(201);
  const entry = createRoomContract.response.parse(await response.json());
  return { ...entry, room: fourShogiRoomSchema.parse(entry.room) };
}

export async function get(id: string) {
  const response = await request(`/rooms/${id}`);
  expect(response.status).toBe(200);
  return fourShogiRoomSchema.parse(getRoomContract.response.parse(await response.json()).room);
}

export async function setup(
  mode: "singles" | "doubles" = "singles",
  timeControl?: RoomTimeControl,
) {
  const created = await create(false, mode, timeControl);
  const memberships = [created.membership];
  for (let index = 1; index < 4; index++) {
    const response = await request(
      `/rooms/${created.room.id}/players`,
      json({ name: `将棋${index}` }),
    );
    expect(response.status).toBe(200);
    memberships.push(joinRoomContract.response.parse(await response.json()).membership);
  }
  const clients = await Promise.all(
    memberships.map((member) => connect(created.room.id, member.token)),
  );
  for (let index = 0; index < 4; index++) {
    clients[index].send({ type: "room.ready.set", ready: true });
    await clients[0].room(
      (room) => room.players.filter((player) => player.ready).length === index + 1,
    );
  }
  return { id: created.room.id, memberships, clients };
}

export async function start(mode: "singles" | "doubles" = "singles") {
  const prepared = await setup(mode);
  prepared.clients[0].send({ type: "room.game.start" });
  const room = await prepared.clients[0].room((room) => room.status === "playing");
  if (room.status !== "playing") throw new Error("Not playing");
  return { ...prepared, room };
}

export function sideIndex(setup: Awaited<ReturnType<typeof start>>, side: Side) {
  return setup.room.players.findIndex((player) => player.side === side);
}

export async function resignCurrent(setup: Awaited<ReturnType<typeof start>>, room: FourShogiRoom) {
  if (room.status !== "playing") throw new Error("Not playing");
  const index = sideIndex(setup, room.game.turn);
  setup.clients[index].send({ type: "room.game.resign" });
  return setup.clients[0].room(
    (next) => next.status === "waiting" || next.positionRevision > room.positionRevision,
  );
}

export function registerFourShogiRoomFixtures() {
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
}
