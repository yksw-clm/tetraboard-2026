import {
  createRoomContract,
  getRoomContract,
  roomCodeSchema,
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
