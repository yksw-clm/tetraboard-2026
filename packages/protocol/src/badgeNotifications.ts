import { z } from "zod";
import { badgeIds } from "./badges";

export const badgeNotificationSchema = z.object({
  id: z.string().min(1).max(128),
  game: z.enum(["four-reversi", "four-shogi"]),
  badges: z
    .array(
      z.object({
        id: z.enum(badgeIds),
        tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        previousTier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
        value: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(4),
});
export type BadgeNotification = z.infer<typeof badgeNotificationSchema>;
export const badgeNotificationClaimSchema = z.object({ token: z.uuid() }).strict();
export const badgeNotificationOperationSchema = badgeNotificationClaimSchema.extend({
  id: z.string().min(1).max(128),
});
export const badgeNotificationResponseSchema = z.object({
  notification: badgeNotificationSchema.nullable(),
});
