import { analyticsVisitor } from "../analytics/store";
import {
  createRoomContract,
  getRoomContract,
  getFourShogiReplayContract,
  getRoomMembershipContract,
  joinRoomContract,
  leaveRoomContract,
  listRoomsContract,
  listReportsContract,
  moderateReportContract,
  reportContract,
  roomCodeSchema,
  roomSocketContract,
  roomTimeControl,
  viewerContract,
  type Room,
  type RoomError,
} from "@tetraboard/protocol";
import { profileAvatarUrl } from "../accounts/auth";
import {
  roomEntryProfile,
  reserveAccountSeat,
  cancelReservation,
  RoomAccountError,
  type AccountAdmission,
} from "../accounts/roomAccounts";
import { Hono } from "hono";
import { listRoomIndex } from "./roomIndex";
import { createReport, getReport, listReports, resolveReport } from "./reportStore";

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

function moderatorAuthorized(
  authorization: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !authorization?.startsWith("Bearer ")) return false;
  const candidate = authorization.slice(7);
  if (candidate.length !== secret.length) return false;
  let difference = 0;
  for (let index = 0; index < candidate.length; index++)
    difference |= candidate.charCodeAt(index) ^ secret.charCodeAt(index);
  return difference === 0;
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

  let profile;
  try {
    profile = await roomEntryProfile(context.req.raw, context.env, request.data.name);
  } catch (error) {
    return context.json(
      roomError(error instanceof RoomAccountError ? error.code : "internal_error"),
      error instanceof RoomAccountError ? error.status : 503,
    );
  }
  const token = createMembershipToken();
  const tokenHash = await hashMembershipToken(token);

  for (let attempt = 0; attempt < maxRoomCodeAttempts; attempt++) {
    const code = generateRoomCode();
    const game = request.data.game ?? "four-reversi";
    const initialRoom = {
      eliminations: [],
      id: code,
      instanceId: crypto.randomUUID(),
      status: "waiting",
      settings: {
        game,
        mode: request.data.mode,
        timeControl: roomTimeControl,
        ...(game === "four-shogi"
          ? { threePlayerAttackProhibited: request.data.threePlayerAttackProhibited ?? true }
          : {}),
      },
      publicUpdatedAtMs: Date.now(),
      lastActivityAtMs: Date.now(),
      players: [
        {
          id: crypto.randomUUID(),
          name: profile.name,
          kind: "human",
          avatarUrl: null,
          ready: request.data.quickPlay,
          ...(game === "four-shogi" ? { side: null } : { color: null }),
          reconnectDeadline: null,
        },
        ...(request.data.quickPlay
          ? [1, 2, 3].map((index) => ({
              id: crypto.randomUUID(),
              name: `CPU ${index}`,
              kind: "cpu" as const,
              level: 1 as const,
              ready: true as const,
              ...(game === "four-shogi" ? { side: null } : { color: null }),
              reconnectDeadline: null,
            }))
          : []),
      ],
      game: null,
      clock: null,
      lastRound: null,
      ...(game === "four-shogi"
        ? {
            roundId: null,
            positionRevision: 0,
            legalActions: [],
            checkState: { south: false, west: false, north: false, east: false },
          }
        : {}),
    } as Room;

    let admission: AccountAdmission | undefined;
    try {
      if (profile.user) {
        admission = await reserveAccountSeat(
          context.req.raw,
          context.env,
          profile.user,
          initialRoom,
          initialRoom.players[0].id,
        );
        initialRoom.players[0].name = admission.name;
        if (initialRoom.players[0].kind === "human")
          initialRoom.players[0].avatarUrl = profileAvatarUrl(admission.avatarKey);
      }
      const room = await context.env.GAME_ROOM.getByName(code).createRoom(
        initialRoom,
        tokenHash,
        admission,
        {
          visitorId: analyticsVisitor(context.req.raw),
          accountId: profile.user?.id ?? null,
          isTest: Boolean(profile.user?.isTestUser),
        },
      );
      if (room === null) {
        if (admission) await cancelReservation(context.env, admission);
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
    } catch (error) {
      // A failed response may follow a committed admission. Only the DO can decide.
      if (admission) {
        try {
          await cancelReservation(context.env, admission);
        } catch {
          /* recovered later */
        }
      }
      return context.json(
        roomError(error instanceof RoomAccountError ? error.code : "internal_error"),
        error instanceof RoomAccountError ? error.status : 500,
      );
    }
  }

  return context.json(roomError("code_unavailable"), 503);
});

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
      query.data.game ?? "four-reversi",
    );
    context.header("Cache-Control", "no-store");
    return context.json(listRoomsContract.response.parse(rooms));
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});

roomRoutes.on(getRoomContract.method, getRoomContract.path, async (context) => {
  const code = context.req.param("id");
  if (!roomCodeSchema.safeParse(code).success) {
    return context.json(roomError("invalid_request"), 400);
  }

  try {
    const snapshot = await context.env.GAME_ROOM.getByName(code).getRoomSnapshot();
    context.header("Cache-Control", "no-store");
    return snapshot === null
      ? context.json(roomError("not_found"), 404)
      : context.json(getRoomContract.response.parse(snapshot));
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});

roomRoutes.on(
  getFourShogiReplayContract.method,
  getFourShogiReplayContract.path,
  async (context) => {
    const params = getFourShogiReplayContract.params.safeParse(context.req.param());
    const query = getFourShogiReplayContract.query.safeParse(context.req.query());
    if (!params.success || !query.success) return context.json(roomError("invalid_request"), 400);
    try {
      const result = await context.env.GAME_ROOM.getByName(params.data.id).getShogiReplay(
        query.data.instanceId,
        params.data.roundId,
        query.data.cursor ?? 0,
      );
      context.header("Cache-Control", "no-store");
      if (result.status === "room_changed") return context.json(roomError("room_changed"), 410);
      if (result.status !== "found") return context.json(roomError("not_found"), 404);
      return context.json(getFourShogiReplayContract.response.parse(result.page));
    } catch {
      return context.json(roomError("internal_error"), 500);
    }
  },
);

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

  let admission: AccountAdmission | undefined;
  try {
    const profile = await roomEntryProfile(context.req.raw, context.env, request.data.name);
    if (profile.user) {
      const current = await context.env.GAME_ROOM.getByName(code).getRoom();
      if (!current) return context.json(roomError("not_found"), 404);
      if (request.data.instanceId && request.data.instanceId !== current.instanceId)
        return context.json(roomError("room_changed"), 410);
      admission = await reserveAccountSeat(
        context.req.raw,
        context.env,
        profile.user,
        current,
        crypto.randomUUID(),
      );
    }
    const token = createMembershipToken();
    const tokenHash = await hashMembershipToken(token);
    const result = await context.env.GAME_ROOM.getByName(code).joinRoom(
      admission?.name ?? profile.name,
      tokenHash,
      request.data.instanceId,
      admission,
      {
        visitorId: analyticsVisitor(context.req.raw),
        accountId: profile.user?.id ?? null,
        isTest: Boolean(profile.user?.isTestUser),
      },
    );
    if (result.status !== "joined" && admission) await cancelReservation(context.env, admission);
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
    context.header("Cache-Control", "no-store");
    return context.json(
      joinRoomContract.response.parse({
        room: result.room,
        membership: { ...result.membership, token },
      }),
    );
  } catch (error) {
    if (admission) {
      try {
        await cancelReservation(context.env, admission);
      } catch {
        /* recovered later */
      }
    }
    return context.json(
      roomError(error instanceof RoomAccountError ? error.code : "internal_error"),
      error instanceof RoomAccountError ? error.status : 500,
    );
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

roomRoutes.on(reportContract.method, reportContract.path, async (context) => {
  const code = context.req.param("id");
  if (!roomCodeSchema.safeParse(code).success)
    return context.json(roomError("invalid_request"), 400);
  const token = context.req.header("Authorization")?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if (!token) return context.json(roomError("unauthorized"), 401);
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json(roomError("invalid_request"), 400);
  }
  const request = reportContract.request.safeParse(body);
  if (!request.success) return context.json(roomError("invalid_request"), 400);
  try {
    const target = await context.env.GAME_ROOM.getByName(code).inspectReport(
      token,
      request.data.messageId,
    );
    if (target.status !== "found")
      return target.status === "unauthorized"
        ? context.json(roomError("unauthorized"), 401)
        : context.json(roomError("not_found"), 404);
    const result = await createReport(context.env.APP_DB, {
      roomId: code,
      instanceId: target.instanceId,
      message: target.message,
      reporterHash: target.reporterHash,
    });
    if (result.status !== "created")
      return result.status === "duplicate"
        ? context.json(roomError("conflict"), 409)
        : context.json(roomError("rate_limited"), 429);
    context.header("Cache-Control", "no-store");
    return context.json(reportContract.response.parse({ id: result.id }), 201);
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});

roomRoutes.on(listReportsContract.method, listReportsContract.path, async (context) => {
  const secret = (context.env as Env & { MODERATOR_TOKEN?: string }).MODERATOR_TOKEN;
  if (!secret) return context.json(roomError("internal_error"), 503);
  if (!moderatorAuthorized(context.req.header("Authorization"), secret))
    return context.json(roomError("unauthorized"), 401);
  const query = listReportsContract.query.safeParse(context.req.query());
  if (
    !query.success ||
    (query.data.cursor !== undefined && !/^\d{1,16}:[0-9a-f-]{36}$/.test(query.data.cursor))
  )
    return context.json(roomError("invalid_request"), 400);
  try {
    context.header("Cache-Control", "no-store");
    return context.json(
      listReportsContract.response.parse(await listReports(context.env.APP_DB, query.data.cursor)),
    );
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});

roomRoutes.on(moderateReportContract.method, moderateReportContract.path, async (context) => {
  const secret = (context.env as Env & { MODERATOR_TOKEN?: string }).MODERATOR_TOKEN;
  if (!secret) return context.json(roomError("internal_error"), 503);
  if (!moderatorAuthorized(context.req.header("Authorization"), secret))
    return context.json(roomError("unauthorized"), 401);
  const id = context.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    return context.json(roomError("invalid_request"), 400);
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return context.json(roomError("invalid_request"), 400);
  }
  const request = moderateReportContract.request.safeParse(body);
  if (!request.success) return context.json(roomError("invalid_request"), 400);
  try {
    const report = await getReport(context.env.APP_DB, id);
    if (report === null) return context.json(roomError("not_found"), 404);
    if (report.status === "resolved")
      return report.action === request.data.action
        ? context.json(report)
        : context.json(roomError("conflict"), 409);
    const action = request.data.action;
    if (action !== "dismiss") {
      const status = await context.env.GAME_ROOM.getByName(report.roomId).moderateMessage(
        report.instanceId,
        report.message.id,
        report.message.senderId,
        action === "delete" || action === "delete_and_mute",
        action === "mute" || action === "delete_and_mute",
      );
      if (status === "room_changed") return context.json(roomError("conflict"), 409);
    }
    const resolved = await resolveReport(context.env.APP_DB, id, action);
    if (resolved === null) return context.json(roomError("not_found"), 404);
    if (resolved.action !== action) return context.json(roomError("conflict"), 409);
    context.header("Cache-Control", "no-store");
    return context.json(moderateReportContract.response.parse(resolved));
  } catch {
    return context.json(roomError("internal_error"), 500);
  }
});
