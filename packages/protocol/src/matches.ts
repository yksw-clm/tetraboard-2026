import { defaultGameId, type GameId } from "./games";
import { gameIdSchema } from "./gameSchemas";
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
  fourShogiRoomSettingsSchema,
} from "./rooms";
import {
  fourShogiSideSchema,
  finishedFourShogiStateSchema,
  fourShogiReplayInitialSchema,
  fourShogiReplayEventSchema,
} from "./fourShogi";

export const matchGameSchema = gameIdSchema;

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
export const fourReversiMatchSummarySchema = z
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

const shogiParticipantBase = participantBase
  .omit({ color: true })
  .extend({ side: fourShogiSideSchema });
export const fourShogiMatchParticipantSchema = z.discriminatedUnion("kind", [
  shogiParticipantBase.extend({
    kind: z.literal("human"),
    avatarUrl: z
      .string()
      .regex(/^\/api\/avatars\/[0-9a-f-]{36}$/)
      .nullable(),
  }),
  shogiParticipantBase.extend({ kind: z.literal("cpu"), level: cpuLevelSchema }),
]);
function completeShogiParticipants(
  participants: z.infer<typeof fourShogiMatchParticipantSchema>[],
) {
  return (
    new Set(participants.map((player) => player.id)).size === 4 &&
    new Set(participants.map((player) => player.side)).size === 4 &&
    new Set(participants.map((player) => player.seat)).size === 4
  );
}
function completeShogiResult(result: z.infer<typeof finishedFourShogiStateSchema.shape.result>) {
  return (
    result.mode === "doubles" ||
    (result.standings.length === 4 &&
      new Set(result.standings.map((entry) => entry.side)).size === 4)
  );
}
export const fourShogiMatchSummarySchema = z
  .strictObject({
    id: z.uuid(),
    game: z.literal("four-shogi"),
    mode: roomModeSchema,
    startedAtMs: z.int().nonnegative(),
    endedAtMs: z.int().nonnegative(),
    participants: z.array(fourShogiMatchParticipantSchema).length(4),
    result: finishedFourShogiStateSchema.shape.result,
  })
  .refine(
    (match) =>
      match.result.mode === match.mode &&
      completeShogiParticipants(match.participants) &&
      completeShogiResult(match.result),
  );
export const matchSummarySchema = z.union([
  fourReversiMatchSummarySchema,
  fourShogiMatchSummarySchema,
]);

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
  query: z.object({
    game: matchGameSchema.default(defaultGameId),
    mode: roomModeSchema,
    cursor: matchCursorSchema.optional(),
  }),
  response: z.strictObject({
    matches: z.array(matchSummarySchema).max(20),
    nextCursor: z.string().nullable(),
  }),
} as const;
export type MatchSummary = z.infer<typeof matchSummarySchema>;
export type FourReversiMatchHistoryParticipant = z.infer<typeof matchParticipantSchema>;
export type FourShogiMatchHistoryParticipant = z.infer<typeof fourShogiMatchParticipantSchema>;
export type MatchHistoryParticipant =
  | FourReversiMatchHistoryParticipant
  | FourShogiMatchHistoryParticipant;
export type FourReversiMatchSummary = z.infer<typeof fourReversiMatchSummarySchema>;
export type FourShogiMatchSummary = z.infer<typeof fourShogiMatchSummarySchema>;
export type MatchGame = GameId;

const matchCountSchema = z.int().nonnegative();
export const fourReversiAccountStatsSchema = z.strictObject({
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
export const fourShogiAccountStatsSchema = fourReversiAccountStatsSchema.extend({
  singles: fourReversiAccountStatsSchema.shape.singles.safeExtend({ knockouts: matchCountSchema }),
});
export const accountStatsSchema = z.union([
  fourReversiAccountStatsSchema,
  fourShogiAccountStatsSchema,
]);
export const getAccountStatsContract = {
  method: "GET",
  path: "/account/stats",
  query: z.object({ game: matchGameSchema.default(defaultGameId) }),
  response: accountStatsSchema,
} as const;
export type AccountStats = z.infer<typeof accountStatsSchema>;
export type FourReversiAccountStats = z.infer<typeof fourReversiAccountStatsSchema>;
export type FourShogiAccountStats = z.infer<typeof fourShogiAccountStatsSchema>;

export const publicFourReversiMatchDetailSchema = z
  .strictObject({
    id: z.uuid(),
    roomId: roomCodeSchema,
    startedAtMs: z.int().nonnegative(),
    endedAtMs: z.int().nonnegative(),
    settings: fourReversiRoomSettingsSchema,
    participants: z.array(matchParticipantSchema).length(4),
    game: finishedGameSchema,
    eliminations: z.array(eliminationSchema).max(4),
    replay: roundReplaySchema,
  })
  .refine(
    (match) =>
      match.game.mode === match.settings.mode &&
      match.replay.id === match.id &&
      new Set(match.participants.map((player) => player.id)).size === 4 &&
      new Set(match.participants.map((player) => player.color)).size === 4 &&
      new Set(match.participants.map((player) => player.seat)).size === 4,
  );
const knockoutCountsSchema = z.strictObject({
  south: z.int().min(0).max(3),
  west: z.int().min(0).max(3),
  north: z.int().min(0).max(3),
  east: z.int().min(0).max(3),
});
export const publicFourShogiMatchDetailSchema = z
  .strictObject({
    id: z.uuid(),
    roomId: roomCodeSchema,
    startedAtMs: z.int().nonnegative(),
    endedAtMs: z.int().nonnegative(),
    settings: fourShogiRoomSettingsSchema,
    participants: z.array(fourShogiMatchParticipantSchema).length(4),
    game: finishedFourShogiStateSchema,
    knockouts: knockoutCountsSchema,
    replay: z.strictObject({
      rulesVersion: z.literal(1),
      initial: fourShogiReplayInitialSchema,
      eventCount: z.int().nonnegative(),
    }),
  })
  .refine(
    (match) =>
      match.game.mode === match.settings.mode &&
      match.game.result.mode === match.settings.mode &&
      completeShogiResult(match.game.result) &&
      match.replay.initial.mode === match.settings.mode &&
      match.replay.initial.threePlayerAttackProhibited ===
        match.settings.threePlayerAttackProhibited &&
      match.game.threePlayerAttackProhibited === match.settings.threePlayerAttackProhibited &&
      completeShogiParticipants(match.participants) &&
      match.participants.every(
        (player) =>
          match.game.players[player.side] === player.id &&
          match.replay.initial.players[player.side] === player.id,
      ),
  );
export const fourReversiMatchDetailSchema = publicFourReversiMatchDetailSchema
  .safeExtend({ selfPlayerId: z.uuid() })
  .refine((match) => match.participants.some((player) => player.id === match.selfPlayerId));
export const fourShogiMatchDetailSchema = publicFourShogiMatchDetailSchema
  .safeExtend({ selfPlayerId: z.uuid() })
  .refine((match) => match.participants.some((player) => player.id === match.selfPlayerId));
export const publicMatchDetailSchema = z.union([
  publicFourReversiMatchDetailSchema,
  publicFourShogiMatchDetailSchema,
]);
export type PublicMatchDetail = z.infer<typeof publicMatchDetailSchema>;
export type PublicFourReversiMatchDetail = z.infer<typeof publicFourReversiMatchDetailSchema>;
export type PublicFourShogiMatchDetail = z.infer<typeof publicFourShogiMatchDetailSchema>;
export type ReplayFourReversiMatch = PublicFourReversiMatchDetail & { selfPlayerId?: string };
export type ReplayFourShogiMatch = PublicFourShogiMatchDetail & { selfPlayerId?: string };
export type ReplayMatch = ReplayFourReversiMatch | ReplayFourShogiMatch;
export const listPublicMatchesContract = {
  method: "GET",
  path: "/matches",
  query: z.object({ game: matchGameSchema }),
  response: z.strictObject({ matches: z.array(matchSummarySchema).max(20) }),
} as const;
export const getPublicMatchContract = {
  method: "GET",
  path: "/matches/:matchId",
  pathFor: (id: string) => `/matches/${id}`,
  params: z.strictObject({ matchId: z.uuid() }),
  response: z.strictObject({ match: publicMatchDetailSchema }),
} as const;
export const matchDetailSchema = z.union([
  fourReversiMatchDetailSchema,
  fourShogiMatchDetailSchema,
]);
export const getMatchContract = {
  method: "GET",
  path: "/account/matches/:matchId",
  pathFor: (id: string) => `/account/matches/${id}`,
  params: z.strictObject({ matchId: z.uuid() }),
  response: z.strictObject({ match: matchDetailSchema }),
} as const;
export type MatchDetail = z.infer<typeof matchDetailSchema>;
export type FourReversiMatchDetail = z.infer<typeof fourReversiMatchDetailSchema>;
export type FourShogiMatchDetail = z.infer<typeof fourShogiMatchDetailSchema>;
export function isFourShogiMatch(match: MatchDetail): match is FourShogiMatchDetail;
export function isFourShogiMatch(match: ReplayMatch): match is ReplayFourShogiMatch;
export function isFourShogiMatch(match: ReplayMatch): match is ReplayFourShogiMatch {
  return match.settings.game === "four-shogi";
}
export function isFourReversiMatch(match: MatchDetail): match is FourReversiMatchDetail;
export function isFourReversiMatch(match: ReplayMatch): match is ReplayFourReversiMatch;
export function isFourReversiMatch(match: ReplayMatch): match is ReplayFourReversiMatch {
  return match.settings.game === "four-reversi";
}

export const getMatchReplayContract = {
  method: "GET",
  path: "/account/matches/:matchId/replay",
  pathFor: (id: string) => `/account/matches/${id}/replay`,
  params: getMatchContract.params,
  query: z.object({
    cursor: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().nonnegative()).default(0),
  }),
  response: z.strictObject({
    matchId: z.uuid(),
    rulesVersion: z.literal(1),
    initial: fourShogiReplayInitialSchema,
    eventCount: z.int().nonnegative(),
    events: z
      .array(z.strictObject({ index: z.int().nonnegative(), event: fourShogiReplayEventSchema }))
      .max(100),
    nextCursor: z.int().nonnegative().nullable(),
  }),
} as const;
export type MatchReplayPage = z.infer<typeof getMatchReplayContract.response>;

export const getPublicMatchReplayContract = {
  ...getMatchReplayContract,
  path: "/matches/:matchId/replay",
  pathFor: (id: string) => `/matches/${id}/replay`,
} as const;
