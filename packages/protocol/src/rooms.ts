import { gameIdSchema } from "./gameSchemas";
import { z } from "zod";
import {
  fourShogiSideSchema,
  fourShogiActionSchema,
  fourShogiEliminationSchema,
  playingFourShogiStateSchema,
  finishedFourShogiStateSchema,
  fourShogiReplayPageSchema,
  fourShogiFormationAnalysisSchema,
} from "./fourShogi";

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
export const countCharacters = (text: string): number => Array.from(segmenter.segment(text)).length;

const nicknameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((name) => Array.from(segmenter.segment(name)).length <= 10);

const playerNameRequestSchema = z.strictObject({ name: nicknameSchema.optional() });
export const cpuLevelSchema = z.union([z.literal(1), z.literal(2)]);

export const roomCodeSchema = z.string().regex(/^\d{5}$/);

export const fourReversiColorSchema = z.enum(["black", "white", "red", "blue"]);
export const roomTimeControl = { mainTimeMs: 300_000, byoyomiMs: 30_000 } as const;
export const roomMainTimePresets = [0, 60_000, 180_000, 300_000, 600_000] as const;
export const roomByoyomiPresets = [0, 10_000, 30_000] as const;
export const roomTimeControlSchema = z
  .strictObject({
    mainTimeMs: z.union(roomMainTimePresets.map((value) => z.literal(value))),
    byoyomiMs: z.union(roomByoyomiPresets.map((value) => z.literal(value))),
  })
  .refine((value) => value.mainTimeMs > 0 || value.byoyomiMs > 0, {
    message: "Main time and byoyomi cannot both be disabled",
  });
export type RoomTimeControl = z.infer<typeof roomTimeControlSchema>;
export const roomModeSchema = z.enum(["singles", "doubles"]);
export const fourReversiRoomSettingsSchema = z.strictObject({
  game: z.literal("four-reversi"),
  mode: roomModeSchema,
  timeControl: roomTimeControlSchema,
});
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
export const gameResultSchema = z.discriminatedUnion("mode", [
  singlesResultSchema,
  doublesResultSchema,
]);
const gameStateBaseSchema = z.strictObject({
  mode: roomModeSchema,
  board: z.array(z.array(fourReversiColorSchema.nullable()).length(8)).length(8),
  moveNumber: z.int().nonnegative(),
  lastMove: z
    .strictObject({ x: z.int().min(0).max(7), y: z.int().min(0).max(7) })
    .nullable()
    .default(null),
  eliminatedColors: z.array(fourReversiColorSchema),
  consecutivePasses: z.array(fourReversiColorSchema),
});
const playingGameSchema = gameStateBaseSchema.extend({
  status: z.literal("playing"),
  turn: fourReversiColorSchema,
  result: z.null(),
});
export const finishedGameSchema = gameStateBaseSchema.extend({
  status: z.literal("finished"),
  turn: z.null(),
  result: gameResultSchema,
});
export const fourReversiStateSchema = z.discriminatedUnion("status", [
  playingGameSchema,
  finishedGameSchema,
]);
export const eliminationSchema = z.strictObject({
  color: fourReversiColorSchema,
  reason: z.enum(["resigned", "left", "timeout", "disconnected"]),
});
const replayActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("place"),
    color: fourReversiColorSchema,
    position: z.strictObject({ x: z.int().min(0).max(7), y: z.int().min(0).max(7) }),
  }),
  eliminationSchema.extend({ type: z.literal("eliminate") }),
]);
export const roundReplaySchema = z.strictObject({
  id: z.uuid(),
  initial: playingGameSchema,
  steps: z.array(
    z.strictObject({
      action: replayActionSchema,
      game: fourReversiStateSchema,
      passedColors: z.array(fourReversiColorSchema),
    }),
  ),
});
export type RoundReplay = z.infer<typeof roundReplaySchema>;
const lastRoundSchema = z.strictObject({
  game: finishedGameSchema,
  players: z
    .array(z.strictObject({ id: z.uuid(), name: nicknameSchema, color: fourReversiColorSchema }))
    .length(4),
  replay: roundReplaySchema.nullable().default(null),
});

const playerBaseSchema = z.strictObject({
  id: z.uuid(),
  name: nicknameSchema,
});
const humanPlayerSchema = playerBaseSchema.extend({
  kind: z.literal("human"),
  avatarUrl: z
    .string()
    .regex(/^\/api\/avatars\/[0-9a-f-]{36}$/)
    .nullable()
    .default(null),
  ready: z.boolean(),
  reconnectDeadline: z.int().nonnegative().nullable(),
});
const cpuPlayerSchema = playerBaseSchema.extend({
  kind: z.literal("cpu"),
  level: cpuLevelSchema,
  ready: z.literal(true),
  reconnectDeadline: z.null(),
});
const waitingRoomSchema = z.strictObject({
  eliminations: z.array(eliminationSchema).length(0).default([]),
  id: roomCodeSchema,
  instanceId: z.uuid(),
  status: z.literal("waiting"),
  settings: fourReversiRoomSettingsSchema,
  publicUpdatedAtMs: serverNowMsSchema,
  lastActivityAtMs: serverNowMsSchema,
  players: z.array(
    z.union([
      cpuPlayerSchema.extend({ color: z.null() }),
      humanPlayerSchema.extend({ color: z.null() }),
    ]),
  ),
  game: z.null(),
  clock: z.null(),
  lastRound: lastRoundSchema.nullable(),
});

const activeRoomBaseSchema = z
  .strictObject({
    id: roomCodeSchema,
    instanceId: z.uuid(),
    settings: fourReversiRoomSettingsSchema,
    publicUpdatedAtMs: serverNowMsSchema,
    lastActivityAtMs: serverNowMsSchema,
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
  eliminations: z.array(eliminationSchema).max(4).default([]),
  status: z.literal("playing"),
  game: playingGameSchema,
  clock: playingClockSchema,
  lastRound: z.null(),
});
export const fourReversiRoomSchema = z
  .discriminatedUnion("status", [waitingRoomSchema, playingRoomSchema])
  .superRefine((room, context) => {
    if (room.status !== "waiting" && room.game.mode !== room.settings.mode) {
      context.addIssue({
        code: "custom",
        message: "Room mode does not match game mode",
        path: ["game", "mode"],
      });
    }
  });

export const roomGameSchema = gameIdSchema;
export const fourShogiRoomSettingsSchema = fourReversiRoomSettingsSchema.extend({
  game: z.literal("four-shogi"),
  threePlayerAttackProhibited: z.boolean(),
});
export const roomSettingsSchema = z.discriminatedUnion("game", [
  fourReversiRoomSettingsSchema,
  fourShogiRoomSettingsSchema,
]);
const shogiRemaining = z.strictObject({
  south: z.int().nonnegative(),
  west: z.int().nonnegative(),
  north: z.int().nonnegative(),
  east: z.int().nonnegative(),
});
export const playingShogiClockSchema = z.strictObject({
  remainingMainMs: shogiRemaining,
  turnStartedAt: serverNowMsSchema,
  turnExpiresAt: serverNowMsSchema,
});
const fourShogiLastRoundSchema = z.strictObject({
  roundId: z.uuid(),
  game: finishedFourShogiStateSchema,
  players: z
    .array(z.strictObject({ id: z.uuid(), name: nicknameSchema, side: fourShogiSideSchema }))
    .length(4),
  eventCount: z.int().nonnegative(),
});
const shogiCheckStateSchema = z.strictObject({
  south: z.boolean(),
  west: z.boolean(),
  north: z.boolean(),
  east: z.boolean(),
});
const shogiWaitingSchema = z.strictObject({
  id: roomCodeSchema,
  instanceId: z.uuid(),
  status: z.literal("waiting"),
  settings: fourShogiRoomSettingsSchema,
  publicUpdatedAtMs: serverNowMsSchema,
  lastActivityAtMs: serverNowMsSchema,
  players: z.array(
    z.union([
      cpuPlayerSchema.extend({ side: z.null() }),
      humanPlayerSchema.extend({ side: z.null() }),
    ]),
  ),
  eliminations: z.array(fourShogiEliminationSchema).length(0),
  game: z.null(),
  clock: z.null(),
  lastRound: fourShogiLastRoundSchema.nullable(),
  checkState: shogiCheckStateSchema,
  roundId: z.null(),
  positionRevision: z.literal(0),
  legalActions: z.array(fourShogiActionSchema).length(0),
  threePlayerAttackForbiddenActions: z.array(fourShogiActionSchema).length(0).default([]),
});
const shogiPlayingSchema = z
  .strictObject({
    id: roomCodeSchema,
    instanceId: z.uuid(),
    status: z.literal("playing"),
    settings: fourShogiRoomSettingsSchema,
    publicUpdatedAtMs: serverNowMsSchema,
    lastActivityAtMs: serverNowMsSchema,
    players: z
      .array(
        z.union([
          cpuPlayerSchema.extend({ side: fourShogiSideSchema }),
          humanPlayerSchema.extend({ side: fourShogiSideSchema }),
        ]),
      )
      .length(4),
    eliminations: z.array(fourShogiEliminationSchema).max(4),
    game: playingFourShogiStateSchema,
    clock: playingShogiClockSchema,
    lastRound: z.null(),
    checkState: shogiCheckStateSchema,
    roundId: z.uuid(),
    positionRevision: z.int().nonnegative(),
    legalActions: z.array(fourShogiActionSchema),
    threePlayerAttackForbiddenActions: z.array(fourShogiActionSchema).default([]),
  })
  .refine(
    (room) =>
      new Set(room.players.map((p) => p.side)).size === 4 &&
      room.game.mode === room.settings.mode &&
      room.game.threePlayerAttackProhibited === room.settings.threePlayerAttackProhibited &&
      room.players.every((p) => room.game.players[p.side] === p.id),
  );
export const fourShogiRoomSchema = z.discriminatedUnion("status", [
  shogiWaitingSchema,
  shogiPlayingSchema,
]);
export const roomSchema = z.union([fourReversiRoomSchema, fourShogiRoomSchema]);
export type FourReversiRoom = z.infer<typeof fourReversiRoomSchema>;
export type FourShogiRoom = z.infer<typeof fourShogiRoomSchema>;
export type FourShogiLastRound = z.infer<typeof fourShogiLastRoundSchema>;
export type PlayingShogiClock = z.infer<typeof playingShogiClockSchema>;
export function isFourShogiRoom(room: Room): room is FourShogiRoom {
  return room.settings.game === "four-shogi";
}
export function isFourReversiRoom(room: Room): room is FourReversiRoom {
  return room.settings.game === "four-reversi";
}

export const roomPublicMetadataSchema = z
  .strictObject({
    id: roomCodeSchema,
    game: roomGameSchema,
    mode: roomModeSchema,
    timeControl: fourReversiRoomSettingsSchema.shape.timeControl,
    status: z.enum(["waiting", "playing"]),
    hostName: nicknameSchema.nullable(),
    hostAvatarUrl: z
      .string()
      .regex(/^\/api\/avatars\/[0-9a-f-]{36}$/)
      .nullable()
      .default(null),
    humanCount: z.int().min(0).max(4),
    cpuCount: z.int().min(0).max(4),
    capacity: z.literal(4),
    openSeats: z.int().min(0).max(4),
    updatedAtMs: serverNowMsSchema,
  })
  .refine(
    (metadata) =>
      metadata.humanCount + metadata.cpuCount <= metadata.capacity &&
      metadata.openSeats ===
        (metadata.status === "waiting"
          ? metadata.capacity - metadata.humanCount - metadata.cpuCount
          : 0),
    { message: "Room occupancy does not match available seats" },
  );

export const membershipTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const chatCharacterLimit = 100;
export const chatHistoryLimit = 100;
const storedChatTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((text) => Array.from(segmenter.segment(text)).length <= 200)
  .refine((text) => !/(?:https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b)/i.test(text));
export const chatTextSchema = storedChatTextSchema.refine(
  (text) => countCharacters(text) <= chatCharacterLimit,
);
export const chatMessageSchema = z.strictObject({
  id: z.uuid(),
  kind: z.literal("player").default("player"),
  senderId: z.uuid(),
  senderName: nicknameSchema,
  text: storedChatTextSchema,
  sentAtMs: serverNowMsSchema,
});
export const systemChatMessageSchema = z.strictObject({
  id: z.uuid(),
  kind: z.literal("system"),
  event: z.enum(["joined", "left", "mode_changed"]),
  text: z.string().min(1).max(200),
  sentAtMs: serverNowMsSchema,
});
export const chatEntrySchema = z.union([chatMessageSchema, systemChatMessageSchema]);
export const roomPresenceSchema = z.strictObject({
  hostPlayerId: z.uuid().nullable(),
  connectedPlayerIds: z.array(z.uuid()).max(4),
});

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
    "account_seated",
    "profile_required",
    "room_started",
    "room_changed",
    "unauthorized",
    "upgrade_required",
    "internal_error",
    "conflict",
    "rate_limited",
  ]),
});

export const createRoomContract = {
  method: "POST",
  path: "/rooms",
  request: playerNameRequestSchema.extend({
    quickPlay: z.boolean(),
    mode: roomModeSchema,
    game: roomGameSchema.optional(),
    threePlayerAttackProhibited: z.boolean().optional(),
    timeControl: roomTimeControlSchema.optional(),
  }),
  response: roomEntryResponseSchema,
  error: roomErrorSchema,
} as const;

export const roomListCursorSchema = z
  .string()
  .regex(/^\d{1,16}:\d{5}$/)
  .refine((cursor) => Number.isSafeInteger(Number(cursor.split(":")[0])));
export const listRoomsContract = {
  method: "GET",
  path: "/rooms",
  query: z.strictObject({
    cursor: roomListCursorSchema.optional(),
    game: roomGameSchema.optional(),
  }),
  response: z.strictObject({
    rooms: z.array(roomPublicMetadataSchema).max(20),
    nextCursor: roomListCursorSchema.nullable(),
  }),
  error: roomErrorSchema,
} as const;

export const joinRoomContract = {
  method: "POST",
  path: "/rooms/:id/players",
  pathFor: (id: string) => `/rooms/${id}/players`,
  request: playerNameRequestSchema.extend({ instanceId: z.uuid().optional() }),
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
  query: z.object({ formationAnalysis: z.literal("1").optional() }),
  response: z.strictObject({
    room: roomSchema,
    presence: roomPresenceSchema,
    serverNowMs: serverNowMsSchema,
    formationAnalysis: fourShogiFormationAnalysisSchema.nullable().optional(),
  }),
  error: roomErrorSchema,
} as const;

export const leaveRoomContract = {
  method: "POST",
  path: "/rooms/:id/leave",
  pathFor: (id: string) => `/rooms/${id}/leave`,
  request: z.strictObject({ token: membershipTokenSchema }),
  error: roomErrorSchema,
} as const;
export const viewerContract = {
  method: "POST",
  path: "/rooms/:id/viewers",
  pathFor: (id: string) => `/rooms/${id}/viewers`,
  response: z.strictObject({ token: membershipTokenSchema }),
  error: roomErrorSchema,
} as const;
export const reportContract = {
  method: "POST",
  path: "/rooms/:id/reports",
  pathFor: (id: string) => `/rooms/${id}/reports`,
  request: z.strictObject({ messageId: z.uuid() }),
  response: z.strictObject({ id: z.uuid() }),
  error: roomErrorSchema,
} as const;
export const moderationActionSchema = z.enum(["dismiss", "delete", "mute", "delete_and_mute"]);
export const moderationReportSchema = z.strictObject({
  id: z.uuid(),
  roomId: roomCodeSchema,
  instanceId: z.uuid(),
  message: chatMessageSchema,
  reportedAtMs: serverNowMsSchema,
  status: z.enum(["open", "resolved"]),
  action: moderationActionSchema.nullable(),
});
export const listReportsContract = {
  method: "GET",
  path: "/admin/reports",
  query: z.strictObject({ cursor: z.string().optional() }),
  response: z.strictObject({
    reports: z.array(moderationReportSchema).max(20),
    nextCursor: z.string().nullable(),
  }),
  error: roomErrorSchema,
} as const;
export const moderateReportContract = {
  method: "POST",
  path: "/admin/reports/:id/actions",
  pathFor: (id: string) => `/admin/reports/${id}/actions`,
  request: z.strictObject({ action: moderationActionSchema }),
  response: moderationReportSchema,
  error: roomErrorSchema,
} as const;

export const roomSocketContract = {
  method: "GET",
  path: "/rooms/:id/ws",
  pathFor: (id: string) => `/rooms/${id}/ws`,
  query: z.strictObject({
    instanceId: z.uuid().optional(),
    formationAnalysis: z.literal("1").optional(),
  }),
  clientMessage: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("room.auth"), token: membershipTokenSchema }),
    z.strictObject({ type: z.literal("room.ready.set"), ready: z.boolean() }),
    z.strictObject({ type: z.literal("room.mode.set"), mode: roomModeSchema }),
    z.strictObject({
      type: z.literal("room.time-control.set"),
      timeControl: roomTimeControlSchema,
    }),
    z.strictObject({ type: z.literal("room.three-player-attack.set"), prohibited: z.boolean() }),
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
      type: z.literal("room.game.draw.set"),
      proposed: z.boolean(),
      roundId: z.uuid(),
      positionRevision: z.int().nonnegative(),
    }),
    z.strictObject({ type: z.literal("room.chat.send"), text: z.string() }),
    z
      .strictObject({
        type: z.literal("room.game.action"),
        roundId: z.uuid().optional(),
        positionRevision: z.int().nonnegative().optional(),
        action: z.union([
          fourShogiActionSchema,
          z.strictObject({
            type: z.literal("placeStone"),
            position: z.strictObject({ x: z.int().min(0).max(7), y: z.int().min(0).max(7) }),
          }),
        ]),
      })
      .superRefine((message, context) => {
        if (
          message.action.type !== "placeStone" &&
          (message.roundId === undefined || message.positionRevision === undefined)
        )
          context.addIssue({
            code: "custom",
            message: "Shogi actions require roundId and positionRevision",
          });
        if (
          message.action.type === "placeStone" &&
          (message.roundId !== undefined || message.positionRevision !== undefined)
        )
          context.addIssue({
            code: "custom",
            message: "Reversi actions do not use Shogi position metadata",
          });
      }),
  ]),
  message: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("room.snapshot"),
      room: roomSchema,
      presence: roomPresenceSchema,
      serverNowMs: serverNowMsSchema,
      formationAnalysis: fourShogiFormationAnalysisSchema.nullable().optional(),
    }),
    z.strictObject({ type: z.literal("room.authenticated"), membership: roomMembershipSchema }),
    z.strictObject({
      type: z.literal("room.chat.snapshot"),
      messages: z.array(chatEntrySchema).max(chatHistoryLimit),
    }),
    z.strictObject({
      type: z.literal("room.chat.error"),
      error: z.enum(["unauthorized", "rate_limited", "muted", "invalid_request", "internal_error"]),
    }),
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
        "stale_position",
      ]),
    }),
  ]),
  error: roomErrorSchema,
} as const;

export type CreateRoomRequest = z.infer<typeof createRoomContract.request>;
export type JoinRoomRequest = z.infer<typeof joinRoomContract.request>;
export type Room = z.infer<typeof roomSchema>;
export type RoomMode = z.infer<typeof roomModeSchema>;
export type RoomPublicMetadata = z.infer<typeof roomPublicMetadataSchema>;
export type CpuLevel = z.infer<typeof cpuLevelSchema>;
export type PlayingRoomClock = z.infer<typeof playingClockSchema>;
export type FinishedRoomClock = z.infer<typeof finishedClockSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatEntry = z.infer<typeof chatEntrySchema>;
export type SystemChatMessage = z.infer<typeof systemChatMessageSchema>;
export type RoomPresence = z.infer<typeof roomPresenceSchema>;
export type LastRound = z.infer<typeof lastRoundSchema>;
export type ModerationReport = z.infer<typeof moderationReportSchema>;
export type RoomError = z.infer<typeof roomErrorSchema>;
export type RoomMembership = z.infer<typeof roomMembershipSchema>;
export type RoomSocketClientMessage = z.infer<typeof roomSocketContract.clientMessage>;
export type RoomSocketMessage = z.infer<typeof roomSocketContract.message>;

export const getFourShogiReplayContract = {
  method: "GET",
  path: "/rooms/:id/rounds/:roundId/replay",
  pathFor: (id: string, roundId: string) => `/rooms/${id}/rounds/${roundId}/replay`,
  params: z.strictObject({ id: roomCodeSchema, roundId: z.uuid() }),
  query: z.strictObject({
    instanceId: z.uuid(),
    cursor: z
      .string()
      .regex(/^\d{1,10}$/)
      .transform(Number)
      .pipe(z.int().nonnegative())
      .optional(),
  }),
  response: fourShogiReplayPageSchema,
  error: roomErrorSchema,
} as const;
