import { z } from "zod";
import {
  cpuLevelSchema,
  fourReversiColorSchema,
  gameResultSchema,
  roomModeSchema,
  countCharacters,
} from "./rooms";

const participantBase = z.strictObject({
  id: z.uuid(),
  name: z.string().refine((name) => countCharacters(name) >= 1 && countCharacters(name) <= 10),
  color: fourReversiColorSchema,
  seat: z.int().min(0).max(3),
});
export const matchParticipantSchema = z.discriminatedUnion("kind", [
  participantBase.extend({
    kind: z.literal("human"),
    avatarUrl: z
      .string()
      .regex(/^\/api\/avatars\/[0-9a-f-]{36}$/)
      .nullable(),
  }),
  participantBase.extend({ kind: z.literal("cpu"), level: cpuLevelSchema }),
]);
export const matchSummarySchema = z
  .strictObject({
    id: z.uuid(),
    game: z.literal("four-reversi"),
    mode: roomModeSchema,
    startedAtMs: z.int().nonnegative(),
    endedAtMs: z.int().nonnegative(),
    participants: z.array(matchParticipantSchema).length(4),
    result: gameResultSchema,
  })
  .refine((match) => match.result.mode === match.mode);

export const matchCursorSchema = z
  .string()
  .regex(/^\d+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform((value) => {
    const [timestamp, id] = value.split(":");
    return { startedAtMs: Number(timestamp), id };
  })
  .pipe(z.strictObject({ startedAtMs: z.int().nonnegative(), id: z.uuid() }));

export const listMatchesContract = {
  method: "GET",
  path: "/account/matches",
  query: z.object({ mode: roomModeSchema, cursor: matchCursorSchema.optional() }),
  response: z.strictObject({
    matches: z.array(matchSummarySchema).max(20),
    nextCursor: z.string().nullable(),
  }),
} as const;
export type MatchSummary = z.infer<typeof matchSummarySchema>;
export type MatchHistoryParticipant = z.infer<typeof matchParticipantSchema>;
