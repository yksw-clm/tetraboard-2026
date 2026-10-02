import { z } from "zod";
import { fourReversiStateSchema, nicknameSchema, roomModeSchema } from "./rooms";

export { nicknameSchema } from "./rooms";
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,20}$/);
export const profileInputSchema = z.strictObject({
  name: nicknameSchema,
  username: usernameSchema,
});
export const profileSchema = z.strictObject({
  name: z.string(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  profileCompleted: z.boolean(),
});
export const accountSessionSchema = z.strictObject({ user: profileSchema.nullable() });
export type AccountProfile = z.infer<typeof profileSchema>;
export const statisticsSchema = z.strictObject({
  mode: roomModeSchema,
  total: z.number().int().nonnegative(),
  first: z.number().int().nonnegative(),
  second: z.number().int().nonnegative(),
  third: z.number().int().nonnegative(),
  fourth: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
});
export type AccountStatistics = z.infer<typeof statisticsSchema>;
export const historyPlayerSchema = z.strictObject({
  participantId: z.string(),
  name: z.string(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  kind: z.enum(["human", "cpu"]),
  level: z.union([z.literal(1), z.literal(2)]).nullable(),
  color: z.enum(["black", "white", "red", "blue"]),
  placement: z.number().int().min(1).max(4).nullable(),
  outcome: z.enum(["placement", "win", "loss", "draw"]),
});
export const historyEntrySchema = z.strictObject({
  id: z.string(),
  mode: roomModeSchema,
  finishedAt: z.number(),
  players: z.array(historyPlayerSchema).length(4),
  finalState: fourReversiStateSchema,
});
export const historyPageSchema = z.strictObject({
  entries: z.array(historyEntrySchema),
  nextCursor: z.string().nullable(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export const rankingSchema = z.strictObject({
  entries: z.array(
    z.strictObject({
      rank: z.number().int(),
      name: z.string(),
      username: z.string(),
      avatarUrl: z.string().nullable(),
      count: z.number().int(),
    }),
  ),
});
export type RankingEntry = z.infer<typeof rankingSchema>["entries"][number];
export const historyQuerySchema = z.object({
  mode: roomModeSchema.default("singles"),
  cursor: z.string().max(400).optional(),
});
export const rankingQuerySchema = z.object({
  mode: roomModeSchema.default("singles"),
  metric: z.enum(["wins", "games"]).default("wins"),
});
export const accountPaths = {
  session: "/api/account/session",
  profile: "/api/account/profile",
  setup: "/api/account/setup",
  username: "/api/account/username",
  avatar: "/api/account/avatar",
  statistics: "/api/account/statistics",
  history: "/api/account/history",
  ranking: "/api/games/four-reversi/ranking",
} as const;
export function formatRatio(count: number, total: number): string {
  return (total === 0 ? 0 : count / total).toFixed(3).replace(/^0/, "");
}
