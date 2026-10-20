import { z } from "zod";
import { gameIdSchema } from "./gameSchemas";
import { usernameSchema } from "./accounts";
import { roomCodeSchema, roomPublicMetadataSchema } from "./rooms";
import { rankingEntrySchema } from "./rankings";
import { accountStatsSchema } from "./matches";
import { badgeIds } from "./badges";

export const playerProfileTargetSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("room"),
    roomId: roomCodeSchema,
    instanceId: z.uuid(),
    playerId: z.uuid(),
  }),
  z.strictObject({ source: z.literal("match"), matchId: z.uuid(), playerId: z.uuid() }),
  z.strictObject({ source: z.literal("profile"), profileId: z.uuid() }),
]);
export type PlayerProfileTarget = z.infer<typeof playerProfileTargetSchema>;
export const playerProfileQuerySchema = z.discriminatedUnion("source", [
  playerProfileTargetSchema.options[0].extend({
    game: gameIdSchema,
    includeBadges: z.literal("1").optional(),
    includeStats: z.literal("1").optional(),
  }),
  playerProfileTargetSchema.options[1].extend({
    game: gameIdSchema,
    includeBadges: z.literal("1").optional(),
    includeStats: z.literal("1").optional(),
  }),
  playerProfileTargetSchema.options[2].extend({
    game: gameIdSchema,
    includeBadges: z.literal("1").optional(),
    includeStats: z.literal("1").optional(),
  }),
]);
const count = z.int().nonnegative();
export const playerProfileSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("account"),
    profileId: z.uuid(),
    name: z.string(),
    username: usernameSchema.nullable(),
    isGuest: z.boolean().optional(),
    avatarUrl: z
      .string()
      .regex(/^\/api\/avatars\/[0-9a-f-]{36}$/)
      .nullable(),
    game: gameIdSchema,
    badges: z
      .array(
        z.strictObject({
          id: z.enum(badgeIds),
          tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
          value: count,
        }),
      )
      .max(4)
      .optional(),
    stats: z.union([
      accountStatsSchema,
      z.strictObject({
        singles: z.strictObject({ total: count, first: count }),
        doubles: z.strictObject({ total: count, wins: count }),
      }),
    ]),
  }),
  z.strictObject({ kind: z.literal("guest"), name: z.string(), avatarUrl: z.null() }),
  z.strictObject({ kind: z.literal("cpu"), level: z.union([z.literal(1), z.literal(2)]) }),
]);
export type PlayerProfile = z.infer<typeof playerProfileSchema>;
export const getPlayerProfileContract = {
  method: "GET",
  path: "/player-profile",
  query: playerProfileQuerySchema,
  response: playerProfileSchema,
} as const;
export const previewRoomSchema = roomPublicMetadataSchema.safeExtend({
  profileTarget: playerProfileTargetSchema.optional().nullable(),
});
export type PreviewRoomMetadata = z.infer<typeof previewRoomSchema>;
export const previewRoomListSchema = z.strictObject({
  rooms: z.array(previewRoomSchema).max(20),
  nextCursor: z.string().nullable(),
});
const entries = z.array(rankingEntrySchema.extend({ profileId: z.uuid().optional() })).max(10);
export const previewRankingsSchema = z.strictObject({
  singles: z.strictObject({ first: entries, total: entries, knockouts: entries.optional() }),
  doubles: z.strictObject({ wins: entries, total: entries }),
});
export type PreviewRankings = z.infer<typeof previewRankingsSchema>;

export const previewReversiRankingsSchema = z.strictObject({ wins: entries, total: entries });
export type PreviewReversiRankings = z.infer<typeof previewReversiRankingsSchema>;
