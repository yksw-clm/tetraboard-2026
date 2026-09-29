import {
  createRoomContract,
  getRoomContract,
  joinRoomContract,
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

  for (let attempt = 0; attempt < maxRoomCodeAttempts; attempt++) {
    const code = generateRoomCode();
    const initialRoom: Room = {
      id: code,
      status: "waiting",
      players: [{ id: crypto.randomUUID(), name: request.data.name }],
    };

    try {
      const room = await context.env.GAME_ROOM.getByName(code).createRoom(initialRoom);
      if (room === null) {
        continue;
      }

      context.header("Location", getRoomContract.pathFor(code));
      return context.json(createRoomContract.response.parse(room), 201);
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
    return room === null
      ? context.json(roomError("not_found"), 404)
      : context.json(getRoomContract.response.parse(room));
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
    const result = await context.env.GAME_ROOM.getByName(code).joinRoom(request.data.name);
    if (result.status === "not_found") {
      return context.json(roomError("not_found"), 404);
    }
    if (result.status === "room_full") {
      return context.json(roomError("room_full"), 409);
    }
    return context.json(joinRoomContract.response.parse(result.room));
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
