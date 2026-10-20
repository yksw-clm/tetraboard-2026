import { gameIdSchema, gameScopeSchema } from "./gameSchemas";
import { z } from "zod";
import { acquisitionInputSchema, acquisitionReportSchema } from "./acquisition";

export const analyticsGameSchema = gameIdSchema;
export const analyticsPageSchema = z.enum([
  "general-lobby",
  "lobby",
  "room",
  "replay",
  "account",
  "login",
  "setup",
  "other",
]);
export const analyticsDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });
export const pageViewInputSchema = z
  .object({
    id: z.uuid(),
    page: analyticsPageSchema,
    game: analyticsGameSchema.nullable(),
    acquisition: acquisitionInputSchema.optional(),
  })
  .strict()
  .refine((value) => !["lobby", "room", "replay"].includes(value.page) || value.game !== null)
  .refine((value) => value.page !== "general-lobby" || value.game === null);
export const dwellInputSchema = z
  .object({
    id: z.uuid(),
    days: z
      .array(
        z
          .object({ day: analyticsDateSchema, milliseconds: z.number().int().min(0).max(86400000) })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .refine((value) => new Set(value.days.map((entry) => entry.day)).size === value.days.length);
export const adminAnalyticsQuerySchema = z
  .object({
    from: analyticsDateSchema,
    to: analyticsDateSchema,
    game: gameScopeSchema.default("all"),
    bucket: z.enum(["day", "month"]).default("day"),
    includeInternal: z.enum(["true", "false"]).default("false"),
  })
  .refine(({ from, to }) => {
    const duration = Date.parse(to) - Date.parse(from);
    return duration >= 0 && duration <= 366 * 3 * 86400000;
  });
const count = z.number().nonnegative();
const rate = z.number().min(0).max(1).nullable();
export const analyticsMetricsSchema = z.object({
  visitors: count.nullable(),
  pageViews: count,
  dwellMs: count,
  generalLobbyViews: count.default(0),
  generalLobbyDwellMs: count.default(0),
  humanCompleted: count.nullable().default(null),
  cpuCompleted: count.nullable().default(null),
  newUsers: count,
  started: count,
  completed: count,
  abandoned: count,
  playing: count.nullable(),
  cpuMatches: count,
  humanMatches: count,
  singles: count,
  doubles: count,
  completedDurationMs: count,
  participationMs: count.nullable(),
  registeredActive: count.nullable(),
  guestActive: count.nullable(),
  registeredParticipations: count.nullable(),
  guestParticipations: count.nullable(),
  registeredRetentionEligible: count.nullable(),
  registeredRetained: count.nullable(),
  guestRetentionEligible: count.nullable(),
  guestRetained: count.nullable(),
  conversionEligible: count.nullable(),
  converted: count.nullable(),
  startRate: rate,
  completionRate: rate,
  registeredRetentionRate: rate,
  guestRetentionRate: rate,
});
export const adminAnalyticsSchema = z.object({
  collectedFromMs: z.number().nullable(),
  individualDataFromMs: z.number().optional(),
  asOfMs: z.number(),
  totalUsers: count,
  summary: analyticsMetricsSchema,
  buckets: z.array(z.object({ period: z.string(), metrics: analyticsMetricsSchema })),
  acquisition: acquisitionReportSchema.optional(),
});
export const adminUsersQuerySchema = z.object({
  search: z.string().trim().max(100).default(""),
  cursor: z.string().max(512).optional(),
});
export const adminUserSchema = z.object({
  name: z.string(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  createdAtMs: z.number(),
  profileCompleted: z.boolean(),
  isGuest: z.boolean().optional(),
});
export const adminUsersSchema = z.object({
  users: z.array(adminUserSchema),
  nextCursor: z.string().nullable(),
});
export const adminSessionSchema = z.object({ name: z.string(), username: z.string().nullable() });
export const adminAnalyticsContract = {
  method: "GET",
  path: "/api/admin/analytics",
  query: adminAnalyticsQuerySchema,
  response: adminAnalyticsSchema,
} as const;
export const adminUsersContract = {
  method: "GET",
  path: "/api/admin/users",
  query: adminUsersQuerySchema,
  response: adminUsersSchema,
} as const;
export const adminSessionContract = {
  method: "GET",
  path: "/api/admin/session",
  response: adminSessionSchema,
} as const;
export const pageViewContract = {
  method: "POST",
  path: "/api/analytics/pageviews",
  request: pageViewInputSchema,
} as const;
export const dwellContract = {
  method: "POST",
  path: "/api/analytics/dwell",
  request: dwellInputSchema,
} as const;
export type AnalyticsMetrics = z.infer<typeof analyticsMetricsSchema>;
export type AdminAnalytics = z.infer<typeof adminAnalyticsSchema>;
export type AdminAnalyticsQuery = z.infer<typeof adminAnalyticsQuerySchema>;
export type AdminUsers = z.infer<typeof adminUsersSchema>;
export type AdminUser = z.infer<typeof adminUserSchema>;
