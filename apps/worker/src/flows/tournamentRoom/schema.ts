import { z } from "zod";
import { tournamentSettingsSchema } from "@tetraboard/protocol";
export const prepareTournamentRoomSchema = z.strictObject({
  context: z
    .strictObject({
      tournamentId: z.int().positive(),
      matchSequence: z.int().positive().optional(),
      tournamentKey: z.string().min(1).max(200),
      matchId: z.uuid(),
      startsAtMs: z.int().nonnegative(),
      endsAtMs: z.int().nonnegative(),
      ruleVersion: z.union([z.literal(1), z.literal(2)]),
      settings: tournamentSettingsSchema.optional(),
    })
    .refine((context) => context.ruleVersion === 1 || context.settings !== undefined),
  roomId: z.string().regex(/^\d{5}$/),
  instanceId: z.uuid(),
  players: z
    .array(
      z.strictObject({
        tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
        credentialVersion: z.int().nonnegative().optional(),
        admission: z.strictObject({
          accountId: z.string().min(1),
          operationId: z.string().min(1),
          roomId: z.string().regex(/^\d{5}$/),
          instanceId: z.uuid(),
          playerId: z.uuid(),
          isGuest: z.boolean().optional(),
          name: z.string().min(1),
          avatarKey: z.string().nullable(),
          avatarPresetId: z.string().nullable().optional(),
        }),
      }),
    )
    .length(4),
});
