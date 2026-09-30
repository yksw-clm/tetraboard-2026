import {
  createRoomContract,
  getRoomContract,
  getRoomMembershipContract,
  joinRoomContract,
  leaveRoomContract,
  roomCodeSchema,
  roomSocketContract,
  type Room,
  type RoomError,
} from "@tetraboard/protocol";
import { Hono } from "hono";

export const roomRoutes = new Hono<{ Bindings: Env }>();

const roomCodeCount = 100_000;
const maxRoomCodeAttempts = 20;
const randomLimit = Math.floor(2 ** 32 / roomCodeCount) * roomCodeCount;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function createMembershipToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

async function hashMembershipToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

function generateRoomCode(): string {
  const values = new Uint32Array(1);

  do {
    crypto.getRandomValues(values);
  } while (values[0] >= randomLimit);

  return String(values[0] % roomCodeCount).padStart(5, "0");
}

function roomError(error: RoomError["error"]): RoomError {
  return createRoomContract.error.parse({ error });
}

roomRoutes.on(createRoomContract.method, createRoomContract.path, async (context) => {
  let body: unknown;

  try {
    body = await context.req.json();
  } catch {
    return context.json(roomError("invalid_request"), 400);
  }

  const request = createRoomContract.request.safeParse(body);
  if (!request.success) {
    return context.json(roomError("invalid_request"), 400);
  }

  const token = createMembershipToken();
  const tokenHash = await hashMembershipToken(token);

  for (let attempt = 0; attempt < maxRoomCodeAttempts; attempt++) {
    const code = generateRoomCode();
    const initialRoom: Room = {
      id: code,
      status: "waiting",
      players: [
        {
          id: crypto.randomUUID(),
          name: request.data.name,
          ready: false,
          color: null,
          reconnectDeadline: null,
        },
      ],
      game: null,
      clock: null,
    };

    try {
      const room = await context.env.GAME_ROOM.getByName(code).createRoom(initialRoom, tokenHash);
      if (room === null) {
        continue;
      }

      context.header("Location", getRoomContract.pathFor(code));
      context.header("Cache-Control", "no-store");
      return context.json(
        createRoomContract.response.parse({
          room,
          membership: { playerId: room.players[0].id, role: "host", token },
        }),
        201,
      );
    } catch {
      return context.json(roomError("internal_error"), 500);
    }
  }

  return context.json(roomError("code_unavailable"), 503);
});

roomRoutes.on(getRoomContract.method, getRoomContract.path, async (context) => {
  const code = context.req.param("id");
  if (!roomCodeSchema.safeParse(code).success) {
    return context.json(roomError("invalid_request"), 400);
  }

  try {
    const room = await context.env.GAME_ROOM.getByName(code).getRoom();
    context.header("Cache-Control", "no-store");
    return room === null
      ? context.json(roomError("not_found"), 404)
      : context.json(getRoomContract.response.parse({ room, serverNowMs: Date.now() }));
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});

roomRoutes.on(joinRoomContract.method, joinRoomContract.path, async (context) => {
  const code = context.req.param("id");
  if (!roomCodeSchema.safeParse(code).success) {
    return context.json(roomError("invalid_request"), 400);
  }

  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json(roomError("invalid_request"), 400);
  }

  const request = joinRoomContract.request.safeParse(body);
  if (!request.success) {
    return context.json(roomError("invalid_request"), 400);
  }

  try {
    const token = createMembershipToken();
    const tokenHash = await hashMembershipToken(token);
    const result = await context.env.GAME_ROOM.getByName(code).joinRoom(
      request.data.name,
      tokenHash,
    );
    if (result.status === "not_found") {
      return context.json(roomError("not_found"), 404);
    }
    if (result.status === "room_full") {
      return context.json(roomError("room_full"), 409);
    }
    if (result.status === "room_started") {
      return context.json(roomError("room_started"), 409);
    }
    context.header("Cache-Control", "no-store");
    return context.json(
      joinRoomContract.response.parse({
        room: result.room,
        membership: { ...result.membership, token },
      }),
    );
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});

roomRoutes.on(getRoomMembershipContract.method, getRoomMembershipContract.path, async (context) => {
  const code = context.req.param("id");
  if (!roomCodeSchema.safeParse(code).success) {
    return context.json(roomError("invalid_request"), 400);
  }

  const authorization = context.req.header("Authorization");
  const token = authorization?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if (token === undefined || !getRoomMembershipContract.request.safeParse({ token }).success) {
    return context.json(roomError("unauthorized"), 401);
  }

  try {
    const tokenHash = await hashMembershipToken(token);
    const result = await context.env.GAME_ROOM.getByName(code).getRoomMembership(tokenHash);
    if (result.status === "not_found") {
      return context.json(roomError("not_found"), 404);
    }
    if (result.status === "unauthorized") {
      return context.json(roomError("unauthorized"), 401);
    }
    context.header("Cache-Control", "no-store");
    return context.json(getRoomMembershipContract.response.parse(result.membership));
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});

roomRoutes.on(leaveRoomContract.method, leaveRoomContract.path, async (context) => {
  const code = context.req.param("id");
  if (!roomCodeSchema.safeParse(code).success) {
    return context.json(roomError("invalid_request"), 400);
  }
  const authorization = context.req.header("Authorization");
  const token = authorization?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if (token === undefined || !leaveRoomContract.request.safeParse({ token }).success) {
    return context.json(roomError("unauthorized"), 401);
  }
  try {
    const result = await context.env.GAME_ROOM.getByName(code).leaveRoom(
      await hashMembershipToken(token),
    );
    if (result === "not_found") return context.json(roomError("not_found"), 404);
    if (result === "unauthorized") return context.json(roomError("unauthorized"), 401);
    return context.body(null, 204);
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});

roomRoutes.on(roomSocketContract.method, roomSocketContract.path, async (context) => {
  const code = context.req.param("id");
  if (!roomCodeSchema.safeParse(code).success) {
    return context.json(roomError("invalid_request"), 400);
  }

  if (context.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return context.json(roomError("upgrade_required"), 426);
  }

  try {
    return await context.env.GAME_ROOM.getByName(code).fetch(context.req.raw);
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});
