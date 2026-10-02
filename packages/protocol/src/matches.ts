import { z } from "zod";
import {
  cpuLevelSchema,
  fourReversiColorSchema,
  gameResultSchema,
  roomModeSchema,
  countCharacters,
  roomCodeSchema,
  fourReversiRoomSettingsSchema,
  finishedGameSchema,
  eliminationSchema,
  roundReplaySchema,
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

const matchCountSchema = z.int().nonnegative();
export const accountStatsSchema = z.strictObject({
  singles: z
    .strictObject({
      total: matchCountSchema,
      first: matchCountSchema,
      second: matchCountSchema,
      third: matchCountSchema,
      fourth: matchCountSchema,
    })
    .refine((stats) => stats.total === stats.first + stats.second + stats.third + stats.fourth),
  doubles: z
    .strictObject({
      total: matchCountSchema,
      wins: matchCountSchema,
      losses: matchCountSchema,
      draws: matchCountSchema,
    })
    .refine((stats) => stats.total === stats.wins + stats.losses + stats.draws),
});
export const getAccountStatsContract = {
  method: "GET",
  path: "/account/stats",
  response: accountStatsSchema,
} as const;
export type AccountStats = z.infer<typeof accountStatsSchema>;

export const matchDetailSchema = z
  .strictObject({
    id: z.uuid(),
    roomId: roomCodeSchema,
    startedAtMs: z.int().nonnegative(),
    endedAtMs: z.int().nonnegative(),
    settings: fourReversiRoomSettingsSchema,
    participants: z.array(matchParticipantSchema).length(4),
    selfPlayerId: z.uuid(),
    game: finishedGameSchema,
    eliminations: z.array(eliminationSchema).max(4),
    replay: roundReplaySchema,
  })
  .refine(
    (match) =>
      match.game.mode === match.settings.mode &&
      match.replay.id === match.id &&
      match.participants.some((player) => player.id === match.selfPlayerId) &&
      new Set(match.participants.map((player) => player.id)).size === 4 &&
      new Set(match.participants.map((player) => player.color)).size === 4 &&
      new Set(match.participants.map((player) => player.seat)).size === 4,
  );
export const getMatchContract = {
  method: "GET",
  path: "/account/matches/:matchId",
  pathFor: (id: string) => `/account/matches/${id}`,
  params: z.strictObject({ matchId: z.uuid() }),
  response: z.strictObject({ match: matchDetailSchema }),
} as const;
export type MatchDetail = z.infer<typeof matchDetailSchema>;
