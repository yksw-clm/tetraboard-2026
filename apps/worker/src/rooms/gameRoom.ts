import { roomSchema, roomSocketContract, type Room } from "@tetraboard/protocol";
import { DurableObject } from "cloudflare:workers";

const roomStorageKey = "room";

export class GameRoom extends DurableObject<Env> {
  createRoom(room: Room): Room | null {
    const initialRoom = roomSchema.parse(room);

    if (initialRoom.id !== this.ctx.id.name) {
      throw new Error("Room code does not match Durable Object name");
    }

    return this.ctx.storage.transactionSync(() => {
      if (this.ctx.storage.kv.get(roomStorageKey) !== undefined) {
        return null;
      }

      this.ctx.storage.kv.put(roomStorageKey, initialRoom);
      return initialRoom;
    });
  }

  getRoom(): Room | null {
    const room = this.ctx.storage.kv.get(roomStorageKey);
    return room === undefined ? null : roomSchema.parse(room);
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
