import {
  createRoomContract,
  getRoomContract,
  getRoomMembershipContract,
  joinRoomContract,
  leaveRoomContract,
  roomCodeSchema,
  roomForEntryResponse,
  type Room,
  type RoomError,
} from "@tetraboard/protocol";
import type { Context } from "hono";
import {
  createRoomWithAvailableCode,
  hashMembershipToken,
  joinRequestedRoom,
  type JoinRoomResult,
} from "../flows/roomEntry";

type RoomContext<Path extends string = string> = Context<{ Bindings: Env }, Path>;

export function roomError(error: RoomError["error"]): RoomError {
  return createRoomContract.error.parse({ error });
}

export async function createRoom(context: RoomContext<typeof createRoomContract.path>) {
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

  return createRoomWithAvailableCode(context.env, context.req.raw, request.data, {
    success: (code, room, token) => createdRoomResponse(context, code, room, token),
    failure: (error, status) => context.json(roomError(error), status),
  });
}

function createdRoomResponse(context: RoomContext, code: string, room: Room, token: string) {
  context.header("Location", getRoomContract.pathFor(code));
  context.header("Cache-Control", "no-store");
  return context.json(
    createRoomContract.response.parse({
      room: roomForEntryResponse(room),
      membership: { playerId: room.players[0].id, role: "host", token },
    }),
    201,
  );
}

export async function joinRoom(context: RoomContext<typeof joinRoomContract.path>) {
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

  return joinRequestedRoom(context.env, context.req.raw, code, request.data, {
    success: (result, token) => joinedRoomResponse(context, result, token),
    failure: (error, status) => context.json(roomError(error), status),
  });
}

function joinedRoomResponse(context: RoomContext, result: JoinRoomResult, token: string) {
  if (result.status === "account_reservation_invalid")
    return context.json(roomError("internal_error"), 503);
  if (result.status === "room_changed") {
    return context.json(roomError("room_changed"), 410);
  }
  if (result.status === "not_found") {
    return context.json(roomError("not_found"), 404);
  }
  if (result.status === "room_full") {
    return context.json(roomError("room_full"), 409);
  }
  if (result.status === "room_started") {
    return context.json(roomError("room_started"), 409);
  }
  if (result.status === "matchmaking_required")
    return context.json(roomError("matchmaking_required"), 409);
  if (result.status === "tournament_required")
    return context.json(roomError("tournament_required"), 409);
  context.header("Cache-Control", "no-store");
  return context.json(
    joinRoomContract.response.parse({
      room: roomForEntryResponse(result.room),
      membership: { ...result.membership, token },
    }),
  );
}

export async function getRoomMembership(
  context: RoomContext<typeof getRoomMembershipContract.path>,
) {
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
}

export async function leaveRoom(context: RoomContext<typeof leaveRoomContract.path>) {
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
}
