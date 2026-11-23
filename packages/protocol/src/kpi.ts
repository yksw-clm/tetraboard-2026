import { z } from "zod";

export const kpiWeekCount = 12;

export const kpiQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine(({ from, to }) => {
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
    return days >= 1 && days <= 92;
  });
const count = z.number().nonnegative();
export const kpiRatioSchema = z.object({
  numerator: count,
  denominator: count,
  rate: z.number().min(0).max(1).nullable(),
});
export const eventKpiSchema = z.object({
  visitingBrowsers: count,
  matchStartRate: kpiRatioSchema,
  matchCompletionRate: kpiRatioSchema,
  humanMatchRate: kpiRatioSchema,
  acquisition: z.array(
    z.object({
      referrerClass: z.string(),
      utmSource: z.string(),
      utmMedium: z.string(),
      utmCampaign: z.string(),
      device: z.string(),
      visitingBrowsers: count,
      participatingBrowsers: count,
    }),
  ),
  registration: z.array(z.object({ entry: z.string(), stage: z.string(), flows: count })),
  matchmaking: z.array(
    z.object({
      stage: z.string(),
      count,
      waitingMs: z.object({ median: count.nullable(), p90: count.nullable() }),
    }),
  ),
});
const weeklyActivePlayersSchema = z
  .array(
    z.object({
      weekStart: z.string().refine((date) => {
        const midnight = `${date}T00:00:00.000Z`;
        const start = new Date(midnight);
        return start.getUTCDay() === 1 && start.toISOString() === midnight;
      }),
      players: z.int().nonnegative(),
      linked: z.int().nonnegative(),
      partial: z.boolean(),
    }),
  )
  .length(kpiWeekCount);

export const kpiReportSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  computedAtMs: z.number().int(),
  completedMatches: count,
  players: count,
  weeklyActivePlayers: weeklyActivePlayersSchema,
  replayWithin7Days: kpiRatioSchema.extend({ observing: count }),
  newRegistrations: count.nullable(),
  events: eventKpiSchema.nullable(),
  eventsUnavailableReason: z.string().nullable(),
  sampling: z.union([z.boolean(), z.literal("unknown")]),
});
export type KpiQuery = z.infer<typeof kpiQuerySchema>;
export type KpiRatio = z.infer<typeof kpiRatioSchema>;
export type EventKpi = z.infer<typeof eventKpiSchema>;
export type KpiReport = z.infer<typeof kpiReportSchema>;
