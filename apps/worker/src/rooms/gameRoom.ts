import {
  joinRoomContract,
  roomMembershipSchema,
  roomSchema,
  roomSocketContract,
  type Room,
  type RoomMembership,
} from "@tetraboard/protocol";
import { DurableObject } from "cloudflare:workers";

const roomStorageKey = "room";
const membershipStorageKey = (tokenHash: string) => `membership:${tokenHash}`;

export class GameRoom extends DurableObject<Env> {
  createRoom(room: Room, tokenHash: string): Room | null {
    const initialRoom = roomSchema.parse(room);

    if (initialRoom.id !== this.ctx.id.name) {
      throw new Error("Room code does not match Durable Object name");
    }

    return this.ctx.storage.transactionSync(() => {
      if (
        this.ctx.storage.kv.get(roomStorageKey) !== undefined ||
        this.ctx.storage.kv.get(membershipStorageKey(tokenHash)) !== undefined
      ) {
        return null;
      }

      this.ctx.storage.kv.put(roomStorageKey, initialRoom);
      this.ctx.storage.kv.put(
        membershipStorageKey(tokenHash),
        roomMembershipSchema.parse({ playerId: initialRoom.players[0].id, role: "host" }),
      );
      return initialRoom;
    });
  }

  getRoom(): Room | null {
    const room = this.ctx.storage.kv.get(roomStorageKey);
    return room === undefined ? null : roomSchema.parse(room);
  }

  getRoomMembership(
    tokenHash: string,
  ):
    | { status: "found"; membership: RoomMembership }
    | { status: "not_found" }
    | { status: "unauthorized" } {
    const room = this.getRoom();
    if (room === null) {
      return { status: "not_found" };
    }

    const value = this.ctx.storage.kv.get(membershipStorageKey(tokenHash));
    if (value === undefined) {
      return { status: "unauthorized" };
    }

    const membership = roomMembershipSchema.parse(value);
    return room.players.some((player) => player.id === membership.playerId)
      ? { status: "found", membership }
      : { status: "unauthorized" };
  }

  joinRoom(
    name: string,
    tokenHash: string,
  ):
    | { status: "joined"; room: Room; membership: RoomMembership }
    | { status: "not_found" }
    | { status: "room_full" } {
    const playerName = joinRoomContract.request.parse({ name }).name;
    const result = this.ctx.storage.transactionSync(() => {
      const room = this.getRoom();
      if (room === null) {
        return { status: "not_found" } as const;
      }
      if (room.players.length >= 4) {
        return { status: "room_full" } as const;
      }
      if (this.ctx.storage.kv.get(membershipStorageKey(tokenHash)) !== undefined) {
        throw new Error("Membership token collision");
      }

      const playerId = crypto.randomUUID();
      const updatedRoom = roomSchema.parse({
        ...room,
        players: [...room.players, { id: playerId, name: playerName }],
      });
      const membership = roomMembershipSchema.parse({ playerId, role: "player" });
      this.ctx.storage.kv.put(roomStorageKey, updatedRoom);
      this.ctx.storage.kv.put(membershipStorageKey(tokenHash), membership);
      return { status: "joined", room: updatedRoom, membership } as const;
    });

    if (result.status === "joined") {
      const message = JSON.stringify(
        roomSocketContract.message.parse({ type: "room.snapshot", room: result.room }),
      );
      for (const socket of this.ctx.getWebSockets()) {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(message);
          } catch {
            // 切断中の接続への送信失敗は、保存済みの入室結果に影響させません。
          }
        }
      }
    }

    return result;
  }

  async fetch(request: Request): Promise<Response> {
    const room = this.getRoom();
    if (room === null) {
      return Response.json(roomSocketContract.error.parse({ error: "not_found" }), { status: 404 });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(roomSocketContract.error.parse({ error: "upgrade_required" }), {
        status: 426,
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(roomSocketContract.message.parse({ type: "room.snapshot", room })));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket): void {
    socket.close(1003, "Read-only room connection");
  }
}
