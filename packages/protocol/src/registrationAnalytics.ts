import { z } from "zod";
import { gameIdSchema, gameScopeSchema } from "./gameSchemas";
import { adminAnalyticsQuerySchema, analyticsDateSchema } from "./admin";
export const registrationEntrySchema = z.enum([
  "account-menu",
  "mobile-navigation",
  "login-page",
  "guest-account",
  "room-result",
  "rated-match",
  "profile-edit",
  "account-link",
  "unknown",
]);
export const registrationAnalyticsInputSchema = z
  .object({
    id: z.uuid(),
    entry: registrationEntrySchema,
    game: gameIdSchema.nullable(),
  })
  .strict();
export const registrationStageSchema = z.enum([
  "entry",
  "oauth_start",
  "oauth_success",
  "registered",
  "existing_login",
  "profile_required",
  "profile_complete",
]);
export const trackingLinkInputSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    medium: z.string().trim().min(1).max(64),
    campaign: z.string().trim().min(1).max(64),
  })
  .strict();
export const trackingLinkUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const trackingLinkSchema = trackingLinkInputSchema.extend({
  id: z.number().int().positive().safe(),
  archived: z.boolean(),
  createdAtMs: z.number(),
});
export const trackingLinksSchema = z.object({
  links: z.array(trackingLinkSchema),
  nextCursor: z.number().int().positive().nullable(),
});
export const registrationAnalyticsQuerySchema = adminAnalyticsQuerySchema.safeExtend({
  dateBasis: z.enum(["entry", "event"]).default("entry"),
});
export const registrationAnalyticsReportSchema = z.object({
  collectedFromMs: z.number(),
  aggregatedAtMs: z.number().nullable(),
  metricVersion: z.literal(1),
  dateBasis: z.enum(["entry", "event"]),
  status: z.enum(["unmeasured", "ready", "delayed"]),
  rows: z.array(
    z.object({
      day: analyticsDateSchema,
      entryDay: analyticsDateSchema,
      entry: registrationEntrySchema,
      game: gameScopeSchema,
      kind: z.enum(["registered", "guest", "unregistered"]),
      stage: registrationStageSchema,
      linkId: z.number().int().positive().nullable(),
      source: z.string(),
      medium: z.string(),
      campaign: z.string(),
      referrerClass: z.string(),
      device: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
});
export const registrationAnalyticsContract = {
  method: "POST",
  path: "/api/analytics/registration",
  request: registrationAnalyticsInputSchema,
} as const;
export const adminTrackingLinksContract = {
  method: "GET",
  path: "/api/admin/tracking-links",
  response: trackingLinksSchema,
} as const;
export const adminCreateTrackingLinkContract = {
  method: "POST",
  path: "/api/admin/tracking-links",
  request: trackingLinkInputSchema,
  response: trackingLinkSchema,
} as const;
export const adminUpdateTrackingLinkContract = {
  method: "PATCH",
  path: "/api/admin/tracking-links/:id",
  request: trackingLinkUpdateSchema,
  response: trackingLinkSchema,
} as const;
export const adminRegistrationAnalyticsContract = {
  method: "GET",
  path: "/api/admin/analytics/registration",
  query: registrationAnalyticsQuerySchema,
  response: registrationAnalyticsReportSchema,
} as const;
export type RegistrationAnalyticsInput = z.infer<typeof registrationAnalyticsInputSchema>;
export type RegistrationEntry = z.infer<typeof registrationEntrySchema>;
export type TrackingLink = z.infer<typeof trackingLinkSchema>;
export type RegistrationAnalyticsReport = z.infer<typeof registrationAnalyticsReportSchema>;
