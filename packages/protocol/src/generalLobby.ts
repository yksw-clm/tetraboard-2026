import { z } from "zod";
import { roomPublicMetadataSchema } from "./rooms";
import { matchSummarySchema } from "./matches";
import { chatTextSchema } from "./rooms";

export const lobbyRoomSchema = roomPublicMetadataSchema.safeExtend({ instanceId: z.uuid() });
export const lobbyRoomsQuerySchema = z.strictObject({
  capacity: z.enum(["2", "4"]).optional(),
  cursor: z
    .string()
    .regex(/^[012]:\d{1,16}:\d{5}$/)
    .refine((v) => Number.isSafeInteger(Number(v.split(":")[1])))
    .optional(),
});
export const lobbyRoomsSchema = z.object({
  rooms: z.array(lobbyRoomSchema).max(20),
  nextCursor: z.string().nullable(),
});
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
  z.object({ action: z.literal("accepting"), accepting: z.boolean() }).strict(),
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
    }),
  ),
  stoppedSenders: z.array(z.object({ senderId: z.string(), senderName: z.string() })),
});
export type LobbyRoom = z.infer<typeof lobbyRoomSchema>;
export type LobbyMessage = z.infer<typeof lobbyMessageSchema>;
export type LobbyChat = z.infer<typeof lobbyChatSchema>;

export const lobbyOperationResultSchema = z.object({ message: z.string() });
export type LobbyModeration = z.infer<typeof lobbyModerationSchema>;
