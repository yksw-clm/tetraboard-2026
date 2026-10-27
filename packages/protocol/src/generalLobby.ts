import { z } from "zod";
import { playerAppearanceSchema, roomPublicMetadataSchema, roomModeSchema } from "./rooms";
import { gameIdSchema } from "./gameSchemas";
import { gameCatalog } from "./games";
import { playerProfileTargetSchema } from "./playerProfiles";
import { matchSummarySchema } from "./matches";
import { chatTextSchema } from "./rooms";

export const lobbyRoomSchema = roomPublicMetadataSchema.safeExtend({ instanceId: z.uuid() });
export const lobbyRoomsQuerySchema = z
  .strictObject({
    view: z.literal("cards").optional(),
    game: gameIdSchema.optional(),
    capacity: z.enum(["2", "4"]).optional(),
    mode: roomModeSchema.optional(),
    joinable: z.enum(["true", "false"]).optional(),
    cursor: z
      .string()
      .regex(/^[012]:\d{1,16}:\d{5}$/)
      .refine((v) => Number.isSafeInteger(Number(v.split(":")[1])))
      .optional(),
  })
  .refine(
    (query) =>
      query.view === "cards" ||
      (query.game === undefined && query.mode === undefined && query.joinable === undefined),
    { message: "Card filters require the card view" },
  )
  .refine((query) => !query.mode || !query.game || gameCatalog[query.game].hasModes, {
    message: "This game does not have room modes",
  });
export const lobbyRoomsSchema = z.object({
  rooms: z.array(lobbyRoomSchema).max(20),
  nextCursor: z.string().nullable(),
});
export const lobbyRoomParticipantSchema = z.discriminatedUnion("kind", [
  playerAppearanceSchema.options[0]
    .extend({
      profileTarget: playerProfileTargetSchema.options[0].nullable(),
    })
    .refine((participant) => !participant.retired || participant.profileTarget === null, {
      message: "Retired participants cannot expose a profile target",
    }),
  playerAppearanceSchema.options[1],
]);
export const lobbyRoomCardSchema = lobbyRoomSchema
  .safeExtend({
    participants: z.array(lobbyRoomParticipantSchema).max(4),
    profileTarget: playerProfileTargetSchema.nullable().optional(),
  })
  .refine(
    (room) =>
      room.participants.length === room.humanCount + room.cpuCount &&
      room.participants.filter((participant) => participant.kind === "human").length ===
        room.humanCount,
    { message: "Participant previews do not match room occupancy" },
  );
export const lobbyRoomCardsSchema = z.object({
  rooms: z.array(lobbyRoomCardSchema).max(20),
  nextCursor: z.string().nullable(),
  totalCount: z.int().nonnegative(),
});
export type LobbyRoomCard = z.infer<typeof lobbyRoomCardSchema>;
export type LobbyRoomCards = z.infer<typeof lobbyRoomCardsSchema>;
export type LobbyRoomsQuery = z.infer<typeof lobbyRoomsQuerySchema>;
export const lobbyMatchesSchema = z.object({ matches: z.array(matchSummarySchema).max(20) });
export const lobbyMessageSchema = z.object({
  id: z.uuid(),
  senderId: z.string().min(1).max(200),
  senderName: z.string(),
  avatarUrl: z.string().nullable(),
  text: z.string(),
  sentAtMs: z.number().int(),
  own: z.boolean(),
});
export const lobbyChatSchema = z.object({
  messages: z.array(lobbyMessageSchema).max(500),
  nextCursor: z.string().nullable(),
  acceptingPosts: z.boolean(),
  postingStopped: z.boolean(),
  availableAtMs: z.number().int(),
  serverTimeMs: z.number().int(),
});
export const tournamentChatSchema = lobbyChatSchema.extend({
  entered: z.boolean(),
  closesAtMs: z.number().int().nullable(),
});
export const lobbyTextSchema = chatTextSchema;
export const lobbyPostSchema = z.object({ requestId: z.uuid(), text: lobbyTextSchema }).strict();
export const lobbyPostResultSchema = z.object({
  message: lobbyMessageSchema.nullable(),
  availableAtMs: z.number().int(),
});
export const lobbyReportSchema = z.object({ messageId: z.uuid() }).strict();
export const lobbyModerationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), messageId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("stop"),
      senderId: z.string().min(1).max(200),
      stopped: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("accepting"),
      accepting: z.boolean(),
      tournamentId: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ action: z.literal("resolve"), reportId: z.uuid() }).strict(),
]);
export const lobbyAdminSchema = z.object({
  acceptingPosts: z.boolean(),
  reports: z.array(
    z.object({
      id: z.uuid(),
      messageId: z.uuid(),
      senderId: z.string().nullable(),
      senderName: z.string(),
      text: z.string(),
      sentAtMs: z.number(),
      reportedAtMs: z.number(),
      status: z.enum(["pending", "resolved"]),
      tournamentId: z.number().int().positive().nullable().optional(),
    }),
  ),
  stoppedSenders: z.array(z.object({ senderId: z.string(), senderName: z.string() })),
});
export type LobbyRoom = z.infer<typeof lobbyRoomSchema>;
export type LobbyMessage = z.infer<typeof lobbyMessageSchema>;
export type LobbyChat = z.infer<typeof lobbyChatSchema>;

export const lobbyOperationResultSchema = z.object({ message: z.string() });
export type LobbyModeration = z.infer<typeof lobbyModerationSchema>;
