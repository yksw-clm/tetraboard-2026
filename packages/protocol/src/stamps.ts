import { z } from "zod";

export const roomStampIds = ["hello", "like", "thanks", "surprise", "applause", "cry"] as const;
export type RoomStampId = (typeof roomStampIds)[number];
export const roomStamps: Record<RoomStampId, { emoji: string; name: string }> = {
  hello: { emoji: "👋", name: "よろしく！" },
  like: { emoji: "👍", name: "いいね！" },
  thanks: { emoji: "🙏", name: "ありがとう！" },
  surprise: { emoji: "😮", name: "びっくり！" },
  applause: { emoji: "👏", name: "おつかれさま！" },
  cry: { emoji: "😭", name: "泣く" },
};
export const roomInteractionIntervalMs = 3_000;
export const roomStampDurationMs = 3_000;
export const roomStampSendSchema = z.strictObject({
  type: z.literal("room.stamp.send"),
  instanceId: z.uuid(),
  requestId: z.uuid(),
  stampId: z.enum(roomStampIds),
});
export const roomStampReceivedSchema = z.strictObject({
  type: z.literal("room.stamp.received"),
  id: z.uuid(),
  instanceId: z.uuid(),
  requestId: z.uuid(),
  senderId: z.uuid(),
  stampId: z.enum(roomStampIds),
  sentAtMs: z.int().nonnegative(),
});
export const roomStampErrorSchema = z.strictObject({
  type: z.literal("room.stamp.error"),
  requestId: z.uuid(),
  error: z.enum([
    "unauthorized",
    "rate_limited",
    "muted",
    "invalid_request",
    "room_changed",
    "internal_error",
  ]),
  interactionAvailableAtMs: z.int().nonnegative().optional(),
});
export type RoomStampNotification = z.infer<typeof roomStampReceivedSchema>;
