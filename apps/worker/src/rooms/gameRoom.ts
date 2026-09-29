import {
  joinRoomContract,
  membershipTokenSchema,
  roomMembershipSchema,
  roomSchema,
  roomSocketContract,
  type Room,
  type RoomMembership,
  type RoomSocketMessage,
} from "@tetraboard/protocol";
import {
  applyAction,
  colors,
  createInitialState,
  type FourReversiAction,
} from "@tetraboard/four-reversi";
import { DurableObject } from "cloudflare:workers";

const roomStorageKey = "room";
const membershipStorageKey = (tokenHash: string) => `membership:${tokenHash}`;
type RoomSocketError = Extract<RoomSocketMessage, { type: "room.error" }>["error"];

async function hashMembershipToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function randomIndex(length: number): number {
  const range = 2 ** 32;
  const limit = Math.floor(range / length) * length;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return value[0] % length;
}

function shuffledColors(): (typeof colors)[number][] {
  const result: (typeof colors)[number][] = [...colors];
  for (let index = result.length - 1; index > 0; index--) {
    const other = randomIndex(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

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
    | { status: "room_full" }
    | { status: "room_started" } {
    const playerName = joinRoomContract.request.parse({ name }).name;
    const result = this.ctx.storage.transactionSync(() => {
      const room = this.getRoom();
      if (room === null) {
        return { status: "not_found" } as const;
      }
      if (room.status !== "waiting") {
        return { status: "room_started" } as const;
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
        players: [...room.players, { id: playerId, name: playerName, ready: false, color: null }],
      });
      const membership = roomMembershipSchema.parse({ playerId, role: "player" });
      this.ctx.storage.kv.put(roomStorageKey, updatedRoom);
      this.ctx.storage.kv.put(membershipStorageKey(tokenHash), membership);
      return { status: "joined", room: updatedRoom, membership } as const;
    });

    if (result.status === "joined") {
      this.broadcastRoom(result.room);
    }

    return result;
  }

  private broadcastRoom(room: Room): void {
    const message = JSON.stringify(
      roomSocketContract.message.parse({ type: "room.snapshot", room }),
    );
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(message);
      } catch {
        // 切断中の接続への送信失敗は、保存済みのルーム状態に影響させません。
      }
    }
  }

  private sendSocketError(socket: WebSocket, error: RoomSocketError): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(roomSocketContract.message.parse({ type: "room.error", error })));
    }
  }

  private setReady(
    tokenHash: string,
    ready: boolean,
  ):
    | { status: "updated"; room: Room }
    | { status: "unchanged" }
    | { status: "not_found" }
    | { status: "unauthorized" }
    | { status: "already_started" } {
    return this.ctx.storage.transactionSync(() => {
      const room = this.getRoom();
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };

      const value = this.ctx.storage.kv.get(membershipStorageKey(tokenHash));
      if (value === undefined) return { status: "unauthorized" };
      const membership = roomMembershipSchema.parse(value);
      const player = room.players.find((entry) => entry.id === membership.playerId);
      if (player === undefined) return { status: "unauthorized" };
      if (player.ready === ready) return { status: "unchanged" };

      const updatedRoom = roomSchema.parse({
        ...room,
        players: room.players.map((entry) =>
          entry.id === player.id ? { ...entry, ready } : entry,
        ),
      });
      this.ctx.storage.kv.put(roomStorageKey, updatedRoom);
      return { status: "updated", room: updatedRoom };
    });
  }

  private startGame(
    tokenHash: string,
  ):
    | { status: "started"; room: Room }
    | { status: "not_found" | "unauthorized" | "forbidden" | "not_ready" | "already_started" } {
    return this.ctx.storage.transactionSync(() => {
      const room = this.getRoom();
      if (room === null) return { status: "not_found" };
      if (room.status !== "waiting") return { status: "already_started" };

      const membership = this.getRoomMembership(tokenHash);
      if (membership.status !== "found") return { status: membership.status };
      if (membership.membership.role !== "host") return { status: "forbidden" };
      if (room.players.length !== 4 || room.players.some((player) => !player.ready)) {
        return { status: "not_ready" };
      }

      const assignments = shuffledColors();
      const startedRoom = roomSchema.parse({
        ...room,
        status: "playing",
        players: room.players.map((player, index) => ({
          ...player,
          ready: false,
          color: assignments[index],
        })),
        game: createInitialState("singles"),
      });
      this.ctx.storage.kv.put(roomStorageKey, startedRoom);
      return { status: "started", room: startedRoom };
    });
  }

  private placeStone(
    tokenHash: string,
    action: FourReversiAction,
  ):
    | { status: "placed"; room: Room }
    | {
        status:
          | "not_found"
          | "unauthorized"
          | "game_not_started"
          | "game_finished"
          | "not_your_turn"
          | "invalid_move";
      } {
    return this.ctx.storage.transactionSync(() => {
      const room = this.getRoom();
      if (room === null) return { status: "not_found" };
      if (room.status === "waiting") return { status: "game_not_started" };
      if (room.status === "finished") return { status: "game_finished" };

      const membership = this.getRoomMembership(tokenHash);
      if (membership.status !== "found") return { status: membership.status };
      const player = room.players.find((entry) => entry.id === membership.membership.playerId);
      if (player?.color !== room.game.turn) return { status: "not_your_turn" };

      const result = applyAction(room.game, action);
      if (!result.ok) return { status: "invalid_move" };
      const updatedRoom = roomSchema.parse({
        ...room,
        status: result.state.status,
        game: result.state,
      });
      this.ctx.storage.kv.put(roomStorageKey, updatedRoom);
      return { status: "placed", room: updatedRoom };
    });
  }

  private rejectAction(socket: WebSocket, error: RoomSocketError): void {
    this.sendSocketError(socket, error);
    const room = this.getRoom();
    if (room !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify(roomSocketContract.message.parse({ type: "room.snapshot", room })),
      );
    }
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

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 1024) {
      this.sendSocketError(socket, "invalid_request");
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(message);
    } catch {
      this.sendSocketError(socket, "invalid_request");
      return;
    }

    const parsed = roomSocketContract.clientMessage.safeParse(body);
    if (!parsed.success) {
      this.sendSocketError(socket, "invalid_request");
      return;
    }

    try {
      if (parsed.data.type === "room.auth") {
        const tokenHash = await hashMembershipToken(parsed.data.token);
        const result = this.getRoomMembership(tokenHash);
        if (result.status !== "found") {
          socket.serializeAttachment(null);
          this.sendSocketError(
            socket,
            result.status === "not_found" ? "not_found" : "unauthorized",
          );
          return;
        }

        socket.serializeAttachment({ tokenHash });
        socket.send(
          JSON.stringify(
            roomSocketContract.message.parse({
              type: "room.authenticated",
              membership: result.membership,
            }),
          ),
        );
        return;
      }

      const attachment: unknown = socket.deserializeAttachment();
      const tokenHash =
        typeof attachment === "object" && attachment !== null && "tokenHash" in attachment
          ? membershipTokenSchema.safeParse(attachment.tokenHash)
          : null;
      if (tokenHash === null || !tokenHash.success) {
        this.sendSocketError(socket, "unauthorized");
        return;
      }

      if (parsed.data.type === "room.ready.set") {
        const result = this.setReady(tokenHash.data, parsed.data.ready);
        if (result.status === "updated") {
          this.broadcastRoom(result.room);
        } else if (result.status === "unchanged") {
          const room = this.getRoom();
          if (room !== null) {
            socket.send(
              JSON.stringify(roomSocketContract.message.parse({ type: "room.snapshot", room })),
            );
          }
        } else {
          this.rejectAction(socket, result.status);
        }
        return;
      }

      if (parsed.data.type === "room.game.start") {
        const result = this.startGame(tokenHash.data);
        if (result.status === "started") this.broadcastRoom(result.room);
        else this.rejectAction(socket, result.status);
        return;
      }

      const result = this.placeStone(tokenHash.data, parsed.data.action);
      if (result.status === "placed") this.broadcastRoom(result.room);
      else this.rejectAction(socket, result.status);
    } catch {
      this.sendSocketError(socket, "internal_error");
    }
  }
}
