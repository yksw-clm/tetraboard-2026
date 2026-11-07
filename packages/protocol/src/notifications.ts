import { z } from "zod";
import { badgeNotificationSchema } from "./badgeNotifications";

export const notificationNumberSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const common = {
  id: notificationNumberSchema,
  createdAtMs: z.number().int(),
  read: z.boolean(),
  legacy: z.boolean(),
};
export const notificationSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("announcement"),
    announcement: z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      date: z.string(),
    }),
  }),
  z.object({
    ...common,
    kind: z.literal("tournament"),
    tournament: z.object({
      id: z.number().int().positive(),
      name: z.string(),
      rank: z.union([z.literal(1), z.literal(2)]),
      tied: z.boolean(),
    }),
  }),
  z.object({ ...common, kind: z.literal("badge"), badge: badgeNotificationSchema }),
]);
export type Notification = z.infer<typeof notificationSchema>;
export const notificationListSchema = z.object({
  notifications: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  upperBound: notificationNumberSchema,
});
export type NotificationList = z.infer<typeof notificationListSchema>;
export const notificationUnreadSchema = z.object({
  hasUnread: z.boolean(),
  upperBound: notificationNumberSchema,
});
export const notificationReadSchema = z.object({ id: notificationNumberSchema }).strict();
export const notificationReadAllSchema = z.object({ through: notificationNumberSchema }).strict();
