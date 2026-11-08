import { z } from "zod";
import { roomMembershipSchema, roomCodeSchema } from "./rooms";
export const matchmakingRules = {
  key: "four-reversi:singles:v2:180000:0:casual-v1",
  fillAfterMs: 30_000,
  heartbeatMs: 10_000,
  leaseMs: 30_000,
  connectionGraceMs: 30_000,
  countdownMs: 5_000,
  timeControl: { mainTimeMs: 180_000, byoyomiMs: 0 },
} as const;
export const matchmakingInputSchema = z.strictObject({
  controllerId: z.uuid(),
  operationId: z.uuid(),
});
export const matchmakingControlSchema = matchmakingInputSchema.extend({
  version: z.int().positive(),
});
export const matchmakingStateSchema = z.strictObject({
  enabled: z.boolean().optional(),
  status: z.enum(["idle", "waiting", "matched", "playing"]),
  operationId: z.uuid().optional(),
  controllerId: z.uuid().optional(),
  version: z.int().positive().optional(),
  joinedAtMs: z.int().nonnegative().optional(),
  expiresAtMs: z.int().nonnegative().optional(),
  serverNowMs: z.int().nonnegative(),
  assignment: z
    .strictObject({
      matchId: z.uuid(),
      roomId: roomCodeSchema,
      instanceId: z.uuid(),
      expiresAtMs: z.int().nonnegative(),
      membership: roomMembershipSchema.extend({ token: z.string().regex(/^[a-f0-9]{64}$/) }),
    })
    .optional(),
});
export type MatchmakingState = z.infer<typeof matchmakingStateSchema>;

export const matchmakingQueueReferenceSchema = z.strictObject({
  operationId: z.uuid(),
  controllerId: z.uuid(),
  version: z.int().positive(),
});
export const matchmakingRoomReferenceSchema = matchmakingQueueReferenceSchema.extend({
  identity: z.string().min(1),
  roomId: z.string().regex(/^\d{5}$/),
  instanceId: z.uuid(),
});
