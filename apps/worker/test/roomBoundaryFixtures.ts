import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import {
  createRoomContract,
  getRoomContract,
  joinRoomContract,
  leaveRoomContract,
  roomSocketContract,
  type RoomSocketClientMessage,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import { origin } from "./accountFixtures";

export const boundaryRequest = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${origin}/api${path}`, init));

export const boundaryJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify(body),
});

type Entry = ReturnType<typeof createRoomContract.response.parse>;
type MessageOf<T extends RoomSocketMessage["type"]> = Extract<RoomSocketMessage, { type: T }>;

function hasType<T extends RoomSocketMessage["type"]>(
  message: RoomSocketMessage,
  type: T,
): message is MessageOf<T> {
  return message.type === type;
}

export class BoundarySocket {
  private messages: RoomSocketMessage[] = [];
  private changed: (() => void) | null = null;
  private closed = false;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.messages.push(roomSocketContract.message.parse(JSON.parse(String(event.data))));
      this.changed?.();
    });
    socket.accept();
  }

  send(message: RoomSocketClientMessage): void {
    // 不正入力もサーバーの通信境界で検証できるよう、そのまま送信します。
    this.socket.send(JSON.stringify(message));
  }

  async waitFor<T extends RoomSocketMessage["type"]>(
    type: T,
    predicate: (message: MessageOf<T>) => boolean = () => true,
  ): Promise<MessageOf<T>> {
    if (this.changed !== null) throw new Error("A socket wait is already pending");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.changed = null;
        reject(new Error(`Timed out waiting for ${type}`));
      }, 5000);
      const check = () => {
        for (const [index, message] of this.messages.entries()) {
          if (!hasType(message, type) || !predicate(message)) continue;
          // 別種の通知は保持し、同じ種別の古い状態だけを読み飛ばします。
          this.messages = this.messages.filter((entry, at) => at > index || entry.type !== type);
          clearTimeout(timeout);
          this.changed = null;
          resolve(message);
          return;
        }
      };
      this.changed = check;
      check();
    });
  }

  hasMessage(type: RoomSocketMessage["type"]): boolean {
    return this.messages.some((message) => message.type === type);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}

export class RoomBoundaryFixtures {
  private entries: Entry[] = [];
  private sockets: BoundarySocket[] = [];

  async create(body: unknown): Promise<Entry> {
    const response = await boundaryRequest(createRoomContract.path, boundaryJson(body));
    expect(response.status).toBe(201);
    const entry = createRoomContract.response.parse(await response.json());
    this.entries.push(entry);
    return entry;
  }

  async join(roomId: string, name: string): Promise<Entry> {
    const response = await boundaryRequest(
      joinRoomContract.pathFor(roomId),
      boundaryJson({ name }),
    );
    expect(response.status).toBe(200);
    const entry = joinRoomContract.response.parse(await response.json());
    this.entries.push(entry);
    return entry;
  }

  async snapshot(roomId: string) {
    const response = await boundaryRequest(getRoomContract.pathFor(roomId));
    expect(response.status).toBe(200);
    return getRoomContract.response.parse(await response.json());
  }

  async open(roomId: string, query = ""): Promise<BoundarySocket> {
    const response = await boundaryRequest(roomSocketContract.pathFor(roomId) + query, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    if (!response.webSocket) throw new Error("Missing WebSocket");
    const client = new BoundarySocket(response.webSocket);
    this.sockets.push(client);
    await client.waitFor("room.snapshot", (message) => message.room.id === roomId);
    return client;
  }

  async connect(entry: Entry, query = ""): Promise<BoundarySocket> {
    const client = await this.open(entry.room.id, query);
    client.send({ type: "room.auth", token: entry.membership.token });
    const authenticated = await client.waitFor("room.authenticated");
    expect(authenticated.membership).toEqual({
      playerId: entry.membership.playerId,
      role: entry.membership.role,
    });
    await client.waitFor("room.snapshot", (message) =>
      message.presence.connectedPlayerIds.includes(entry.membership.playerId),
    );
    return client;
  }

  async dispose(): Promise<void> {
    try {
      // 待機席と参加資格を解放してから、残った観戦接続も閉じます。
      for (const entry of this.entries.reverse()) {
        const response = await boundaryRequest(leaveRoomContract.pathFor(entry.room.id), {
          method: "POST",
          headers: { Authorization: `Bearer ${entry.membership.token}`, Origin: origin },
        });
        expect(response.status).toBe(204);
      }
    } finally {
      for (const socket of this.sockets) socket.close();
    }
  }

  forgetClosedRoom(roomId: string): void {
    // 呼出側が閉鎖を確認済みの部屋には、退室APIでの解放は不要です。
    this.entries = this.entries.filter((entry) => entry.room.id !== roomId);
  }
}
