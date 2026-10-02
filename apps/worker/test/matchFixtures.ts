import { env, exports } from "cloudflare:workers";
import {
  createRoomContract,
  joinRoomContract,
  getRoomContract,
  roomSocketContract,
  type Room,
  type RoomMode,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import { accountFixture, origin } from "./accountFixtures";

type TokenMembership = { playerId: string; role: "host" | "player"; token: string };
export const matchRequest = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${origin}/api${path}`, init));
export async function matchRoom(id: string) {
  return getRoomContract.response.parse(await (await matchRequest(`/rooms/${id}`)).json()).room;
}
export class MatchClient {
  private messages: RoomSocketMessage[] = [];
  private receivers: ((message: RoomSocketMessage) => void)[] = [];
  constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = roomSocketContract.message.parse(JSON.parse(String(event.data)));
      const receive = this.receivers.shift();
      if (receive) receive(message);
      else this.messages.push(message);
    });
    socket.accept();
  }
  send(message: RoomSocketClientMessage) {
    this.socket.send(JSON.stringify(message));
  }
  close() {
    this.socket.close();
  }
  private next(): Promise<RoomSocketMessage> {
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve, reject) => {
      const receive = (message: RoomSocketMessage) => {
        clearTimeout(timeout);
        resolve(message);
      };
      const timeout = setTimeout(() => {
        this.receivers = this.receivers.filter((entry) => entry !== receive);
        reject(new Error("Match socket timed out"));
      }, 5000);
      this.receivers.push(receive);
    });
  }
  async until(predicate: (message: RoomSocketMessage) => boolean) {
    for (;;) {
      const message = await this.next();
      if (predicate(message)) return message;
    }
  }
  async snapshot(predicate: (room: Room) => boolean) {
    const message = await this.until((m) => m.type === "room.snapshot" && predicate(m.room));
    if (message.type !== "room.snapshot") throw new Error("Snapshot missing");
    return message.room;
  }
}
export const matchClients: MatchClient[] = [];
export async function matchConnect(id: string, membership: TokenMembership) {
  const response = await matchRequest(`/rooms/${id}/ws`, { headers: { Upgrade: "websocket" } });
  const client = new MatchClient(response.webSocket!);
  matchClients.push(client);
  client.send({ type: "room.auth", token: membership.token });
  await client.until((m) => m.type === "room.authenticated");
  return client;
}
export async function matchSetup(mode: RoomMode = "singles", quickPlay = false, guest = false) {
  const user = await accountFixture();
  const created = createRoomContract.response.parse(
    await (
      await matchRequest("/rooms", {
        method: "POST",
        headers: guest ? { "Content-Type": "application/json" } : user.headers,
        body: JSON.stringify({ mode, quickPlay, ...(guest ? { name: "ゲスト" } : {}) }),
      })
    ).json(),
  );
  const id = created.room.id;
  const memberships = [created.membership];
  if (!quickPlay) {
    for (let index = 1; index < 4; index++) {
      const joined = joinRoomContract.response.parse(
        await (
          await matchRequest(`/rooms/${id}/players`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: `参加者${index}` }),
          })
        ).json(),
      );
      memberships.push(joined.membership);
    }
  }
  const clients = await Promise.all(memberships.map((m) => matchConnect(id, m)));
  return { id, user, memberships, clients };
}
export async function matchStart(setup: Awaited<ReturnType<typeof matchSetup>>) {
  for (let i = 0; i < setup.clients.length; i++) {
    setup.clients[i].send({ type: "room.ready.set", ready: true });
    await setup.clients[0].snapshot((r) => r.players.filter((p) => p.ready).length >= i + 1);
  }
  setup.clients[0].send({ type: "room.game.start" });
  const room = await setup.clients[0].snapshot((r) => r.status === "playing");
  if (room.status !== "playing") throw new Error("Match did not start");
  return room;
}
export async function matchLeave(id: string, membership: TokenMembership) {
  const response = await matchRequest(`/rooms/${id}/leave`, {
    method: "POST",
    headers: { Authorization: `Bearer ${membership.token}` },
  });
  if (response.status !== 204) throw new Error(`Leave failed: ${response.status}`);
}
export async function storedMatch(id: string) {
  return env.APP_DB.prepare("SELECT record_json FROM matches WHERE id = ?")
    .bind(id)
    .first<{ record_json: string }>();
}
