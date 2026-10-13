import { z } from "zod";

export const registrationSecretSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const registrationCredentialSchema = z.object({
  registrationId: z.uuid(),
  secret: registrationSecretSchema,
});
export const startRegistrationSchema = registrationCredentialSchema.extend({
  instanceId: z.uuid(),
  matchId: z.uuid(),
  newTokenHash: registrationSecretSchema,
});
export const registrationStatusSchema = z.object({
  registrationId: z.uuid(),
  roomId: z.string().regex(/^\d{5}$/),
  instanceId: z.uuid(),
  matchId: z.uuid(),
  playerId: z.uuid(),
  holdUntilMs: z.number().int(),
  claimUntilMs: z.number().int(),
  identity: z.enum(["unverified", "profile_required", "ready", "mismatch"]),
  record: z.enum(["unclaimed", "pending", "complete", "expired", "retired", "conflict"]),
  seat: z.enum(["held", "complete", "expired", "cancelled", "conflict", "unavailable"]),
});
export type RegistrationCredential = z.infer<typeof registrationCredentialSchema>;
export type StartRegistration = z.infer<typeof startRegistrationSchema>;
export type RegistrationStatus = z.infer<typeof registrationStatusSchema>;
