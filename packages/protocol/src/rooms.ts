import { z } from "zod";

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

const nicknameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((name) => Array.from(segmenter.segment(name)).length <= 10);

const playerNameRequestSchema = z.strictObject({ name: nicknameSchema });
export const cpuLevelSchema = z.union([z.literal(1), z.literal(2)]);

export const roomCodeSchema = z.string().regex(/^\d{5}$/);

export const fourReversiColorSchema = z.enum(["black", "white", "red", "blue"]);
export const roomTimeControl = { mainTimeMs: 300_000, byoyomiMs: 30_000 } as const;
const serverNowMsSchema = z.int().nonnegative();
const remainingMainMsSchema = z.strictObject({
  black: z.int().nonnegative(),
  white: z.int().nonnegative(),
  red: z.int().nonnegative(),
  blue: z.int().nonnegative(),
});
const playingClockSchema = z.strictObject({
  remainingMainMs: remainingMainMsSchema,
  turnStartedAt: serverNowMsSchema,
  turnExpiresAt: serverNowMsSchema,
});
const finishedClockSchema = z.strictObject({
  remainingMainMs: remainingMainMsSchema,
  turnStartedAt: z.null(),
  turnExpiresAt: z.null(),
});
const fourReversiModeSchema = z.enum(["singles", "doubles"]);
const teamSchema = z.enum(["black-red", "white-blue"]);
const singlesResultSchema = z.strictObject({
  mode: z.literal("singles"),
  reason: z.enum(["board_full", "all_passed", "last_player"]),
  standings: z.array(
    z.strictObject({
      color: fourReversiColorSchema,
      rank: z.int().min(1).max(4),
      stoneCount: z.int().nonnegative().optional(),
    }),
  ),
});
const doublesResultSchema = z.strictObject({
  mode: z.literal("doubles"),
  reason: z.enum(["board_full", "all_passed", "team_eliminated"]),
  winner: teamSchema.nullable(),
  stoneCounts: z.array(
    z.strictObject({ color: fourReversiColorSchema, count: z.int().nonnegative() }),
  ),
  teamTotals: z
    .strictObject({ "black-red": z.int().nonnegative(), "white-blue": z.int().nonnegative() })
    .nullable(),
});
const gameStateBaseSchema = z.strictObject({
  mode: fourReversiModeSchema,
  board: z.array(z.array(fourReversiColorSchema.nullable()).length(8)).length(8),
  moveNumber: z.int().nonnegative(),
  eliminatedColors: z.array(fourReversiColorSchema),
  consecutivePasses: z.array(fourReversiColorSchema),
});
const playingGameSchema = gameStateBaseSchema.extend({
  status: z.literal("playing"),
  turn: fourReversiColorSchema,
  result: z.null(),
});
const finishedGameSchema = gameStateBaseSchema.extend({
  status: z.literal("finished"),
  turn: z.null(),
  result: z.discriminatedUnion("mode", [singlesResultSchema, doublesResultSchema]),
});
export const fourReversiStateSchema = z.discriminatedUnion("status", [
  playingGameSchema,
  finishedGameSchema,
]);

const playerBaseSchema = z.strictObject({
  id: z.uuid(),
  name: nicknameSchema,
});
const humanPlayerSchema = playerBaseSchema.extend({
  kind: z.literal("human").default("human"),
  ready: z.boolean().default(false),
  reconnectDeadline: z.int().nonnegative().nullable().default(null),
});
const cpuPlayerSchema = playerBaseSchema.extend({
  kind: z.literal("cpu"),
  level: cpuLevelSchema,
  ready: z.literal(true),
  reconnectDeadline: z.null(),
});
const waitingRoomSchema = z.strictObject({
  id: roomCodeSchema,
  status: z.literal("waiting"),
  players: z.array(
    z.union([
      cpuPlayerSchema.extend({ color: z.null() }),
      humanPlayerSchema.extend({ color: z.null().default(null) }),
    ]),
  ),
  game: z.null().default(null),
  clock: z.null().default(null),
});

const activeRoomBaseSchema = z
  .strictObject({
    id: roomCodeSchema,
    players: z
      .array(
        z.union([
          cpuPlayerSchema.extend({ color: fourReversiColorSchema }),
          humanPlayerSchema.extend({ color: fourReversiColorSchema }),
        ]),
      )
      .length(4),
  })
  .refine((room) => new Set(room.players.map((player) => player.color)).size === 4);

const playingRoomSchema = activeRoomBaseSchema.safeExtend({
  status: z.literal("playing"),
  game: playingGameSchema,
  clock: playingClockSchema,
});
const finishedRoomSchema = activeRoomBaseSchema.safeExtend({
  status: z.literal("finished"),
  game: finishedGameSchema,
  clock: finishedClockSchema,
});
export const roomSchema = z.discriminatedUnion("status", [
  waitingRoomSchema,
  playingRoomSchema,
  finishedRoomSchema,
]);

export const membershipTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const roomMembershipSchema = z.strictObject({
  playerId: z.uuid(),
  role: z.enum(["host", "player"]),
});

const roomMembershipIssuedSchema = z.strictObject({
  playerId: z.uuid(),
  role: z.enum(["host", "player"]),
  token: membershipTokenSchema,
});

const roomEntryResponseSchema = z.strictObject({
  room: roomSchema,
  membership: roomMembershipIssuedSchema,
});

const roomErrorSchema = z.strictObject({
  error: z.enum([
    "invalid_request",
    "not_found",
    "code_unavailable",
    "room_full",
    "room_started",
    "unauthorized",
    "upgrade_required",
    "internal_error",
  ]),
});

export const createRoomContract = {
  method: "POST",
  path: "/rooms",
  request: playerNameRequestSchema.extend({ quickPlay: z.boolean().default(false) }),
  response: roomEntryResponseSchema,
  error: roomErrorSchema,
} as const;

export const joinRoomContract = {
  method: "POST",
  path: "/rooms/:id/players",
  pathFor: (id: string) => `/rooms/${id}/players`,
  request: playerNameRequestSchema,
  response: roomEntryResponseSchema,
  error: roomErrorSchema,
} as const;

export const getRoomMembershipContract = {
  method: "GET",
  path: "/rooms/:id/me",
  pathFor: (id: string) => `/rooms/${id}/me`,
  request: z.strictObject({ token: membershipTokenSchema }),
  response: roomMembershipSchema,
  error: roomErrorSchema,
} as const;

export const getRoomContract = {
  method: "GET",
  path: "/rooms/:id",
  pathFor: (id: string) => `/rooms/${id}`,
  response: z.strictObject({ room: roomSchema, serverNowMs: serverNowMsSchema }),
  error: roomErrorSchema,
} as const;

export const leaveRoomContract = {
  method: "POST",
  path: "/rooms/:id/leave",
  pathFor: (id: string) => `/rooms/${id}/leave`,
  request: z.strictObject({ token: membershipTokenSchema }),
  error: roomErrorSchema,
} as const;

export const roomSocketContract = {
  method: "GET",
  path: "/rooms/:id/ws",
  pathFor: (id: string) => `/rooms/${id}/ws`,
  clientMessage: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("room.auth"), token: membershipTokenSchema }),
    z.strictObject({ type: z.literal("room.ready.set"), ready: z.boolean() }),
    z.strictObject({ type: z.literal("room.cpu.add"), level: cpuLevelSchema }),
    z.strictObject({ type: z.literal("room.cpu.remove"), playerId: z.uuid() }),
    z.strictObject({
      type: z.literal("room.cpu.level.set"),
      playerId: z.uuid(),
      level: cpuLevelSchema,
    }),
    z.strictObject({ type: z.literal("room.game.start") }),
    z.strictObject({ type: z.literal("room.game.resign") }),
    z.strictObject({
      type: z.literal("room.game.action"),
      action: z.strictObject({
        type: z.literal("placeStone"),
        position: z.strictObject({ x: z.int().min(0).max(7), y: z.int().min(0).max(7) }),
      }),
    }),
  ]),
  message: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("room.snapshot"),
      room: roomSchema,
      serverNowMs: serverNowMsSchema,
    }),
    z.strictObject({ type: z.literal("room.authenticated"), membership: roomMembershipSchema }),
    z.strictObject({
      type: z.literal("room.error"),
      error: z.enum([
        "invalid_request",
        "unauthorized",
        "not_found",
        "internal_error",
        "forbidden",
        "not_ready",
        "already_started",
        "game_not_started",
        "game_finished",
        "not_your_turn",
        "invalid_move",
        "already_eliminated",
        "time_expired",
        "room_full",
        "cpu_not_found",
      ]),
    }),
  ]),
  error: roomErrorSchema,
} as const;

export type CreateRoomRequest = z.infer<typeof createRoomContract.request>;
export type JoinRoomRequest = z.infer<typeof joinRoomContract.request>;
export type Room = z.infer<typeof roomSchema>;
export type CpuLevel = z.infer<typeof cpuLevelSchema>;
export type PlayingRoomClock = z.infer<typeof playingClockSchema>;
export type FinishedRoomClock = z.infer<typeof finishedClockSchema>;
export type RoomError = z.infer<typeof roomErrorSchema>;
export type RoomMembership = z.infer<typeof roomMembershipSchema>;
export type RoomSocketClientMessage = z.infer<typeof roomSocketContract.clientMessage>;
export type RoomSocketMessage = z.infer<typeof roomSocketContract.message>;
