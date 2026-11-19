import { z } from "zod";
import {
  createRoomContract,
  getRoomContract,
  getFourShogiReplayContract,
  getFourShogiAnalysisReplayContract,
  getRoomMembershipContract,
  joinRoomContract,
  leaveRoomContract,
  listRoomsContract,
  previewRoomListSchema,
  roomCodeSchema,
  roomSocketContract,
  shogiReplayPageSchema,
  viewerContract,
} from "@tetraboard/protocol";
import { defaultGameId } from "@tetraboard/protocol/games";
import { Hono } from "hono";
import { completeRoomIndexPreviews, listRoomIndex } from "../adapters/room/roomIndexRead";
import { createRoom, getRoomMembership, joinRoom, leaveRoom, roomError } from "./roomEntryRoutes";
import { registerRoomReportRoutes } from "./roomReportRoutes";

export const roomRoutes = new Hono<{ Bindings: Env }>();

roomRoutes.on(createRoomContract.method, createRoomContract.path, createRoom);

roomRoutes.on(listRoomsContract.method, listRoomsContract.path, async (context) => {
  const query = listRoomsContract.query.safeParse(context.req.query());
  if (!query.success) return context.json(roomError("invalid_request"), 400);
  const cursor = query.data.cursor;
  const position = cursor
    ? { updatedAtMs: Number(cursor.split(":")[0]), id: cursor.split(":")[1] }
    : null;
  try {
    const rooms = await listRoomIndex(
      context.env.APP_DB,
      position,
      query.data.game ?? defaultGameId,
      query.data.profilePreview === "1",
    );
    if (query.data.profilePreview === "1") {
      const completed = await completeRoomIndexPreviews(context.env.GAME_ROOM, rooms.rooms);
      context.header("Cache-Control", "no-store");
      return context.json(
        previewRoomListSchema.parse({ ...rooms, rooms: completed.filter((room) => room !== null) }),
      );
    }
    context.header("Cache-Control", "no-store");
    return context.json(listRoomsContract.response.parse(rooms));
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});

roomRoutes.on(getRoomContract.method, getRoomContract.path, async (context) => {
  const code = context.req.param("id");
  const query = getRoomContract.query.safeParse(context.req.query());
  if (!roomCodeSchema.safeParse(code).success || !query.success) {
    return context.json(roomError("invalid_request"), 400);
  }

  try {
    const snapshot = await context.env.GAME_ROOM.getByName(code).getRoomSnapshot(
      query.data.formationAnalysis === "1",
      query.data.stamps === "1",
      query.data.eliminatedHands === "1",
    );
    context.header("Cache-Control", "no-store");
    return snapshot === null
      ? context.json(roomError("not_found"), 404)
      : context.json(getRoomContract.response.parse(snapshot));
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});

roomRoutes.on(
  getFourShogiAnalysisReplayContract.method,
  getFourShogiAnalysisReplayContract.path,
  async (context) => {
    context.header("Cache-Control", "no-store");
    const params = getFourShogiAnalysisReplayContract.params.safeParse(context.req.param());
    const query = getFourShogiAnalysisReplayContract.query.safeParse(context.req.query());
    if (!params.success || !query.success) return context.json(roomError("invalid_request"), 400);
    try {
      const result = await context.env.GAME_ROOM.getByName(
        params.data.id,
      ).getFourShogiAnalysisReplay(
        query.data.instanceId,
        params.data.roundId,
        query.data.positionRevision,
        query.data.cursor ?? 0,
      );
      if (result.status === "room_changed") return context.json(roomError("room_changed"), 410);
      if (result.status === "stale_position") return context.json(roomError("conflict"), 409);
      if (result.status !== "found") return context.json(roomError("not_found"), 404);
      return context.json(getFourShogiAnalysisReplayContract.response.parse(result.page));
    } catch {
      return context.json(roomError("internal_error"), 500);
    }
  },
);

roomRoutes.on(
  getFourShogiReplayContract.method,
  getFourShogiReplayContract.path,
  async (context) => {
    context.header("Cache-Control", "no-store");
    const params = getFourShogiReplayContract.params.safeParse(context.req.param());
    const query = getFourShogiReplayContract.query.safeParse(context.req.query());
    if (!params.success || !query.success) return context.json(roomError("invalid_request"), 400);
    try {
      const result = await context.env.GAME_ROOM.getByName(params.data.id).getShogiReplay(
        query.data.instanceId,
        params.data.roundId,
        query.data.cursor ?? 0,
      );
      if (result.status === "room_changed") return context.json(roomError("room_changed"), 410);
      if (result.status !== "found") return context.json(roomError("not_found"), 404);
      return context.json(
        z.union([getFourShogiReplayContract.response, shogiReplayPageSchema]).parse(result.page),
      );
    } catch {
      return context.json(roomError("internal_error"), 500);
    }
  },
);

roomRoutes.on(joinRoomContract.method, joinRoomContract.path, joinRoom);

roomRoutes.on(getRoomMembershipContract.method, getRoomMembershipContract.path, getRoomMembership);

roomRoutes.on(leaveRoomContract.method, leaveRoomContract.path, leaveRoom);

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

roomRoutes.on(viewerContract.method, viewerContract.path, async (context) => {
  const code = context.req.param("id");
  if (!roomCodeSchema.safeParse(code).success)
    return context.json(roomError("invalid_request"), 400);
  try {
    const token = await context.env.GAME_ROOM.getByName(code).issueViewerToken();
    if (token === null) return context.json(roomError("not_found"), 404);
    context.header("Cache-Control", "no-store");
    return context.json(viewerContract.response.parse({ token }), 201);
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});

registerRoomReportRoutes(roomRoutes, roomError);
