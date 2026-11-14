import { z } from "zod";
import { gameIdSchema } from "./gameSchemas";
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
export const registrationAnalyticsContract = {
  method: "POST",
  path: "/api/analytics/registration",
  request: registrationAnalyticsInputSchema,
} as const;
export type RegistrationAnalyticsInput = z.infer<typeof registrationAnalyticsInputSchema>;
export type RegistrationEntry = z.infer<typeof registrationEntrySchema>;
