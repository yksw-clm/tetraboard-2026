import {
  fourGomokuSettingsSchema,
  fourGomokuResultSchema,
  fourGomokuFinishedStateSchema,
  fourGomokuReplaySchema,
} from "./rooms";
import {
  gomokuSettingsSchema,
  gomokuResultSchema,
  gomokuFinishedStateSchema,
  gomokuReplaySchema,
} from "./rooms";
import {
  shogiSideSchema,
  finishedShogiStateSchema,
  shogiReplayInitialSchema,
  shogiReplayEventSchema,
} from "./shogi";
import { shogiSettingsSchema } from "./rooms";
import {
  reversiColorSchema,
  reversiResultSchema,
  reversiSettingsSchema,
  reversiFinishedStateSchema,
  reversiEliminationSchema,
  reversiReplaySchema,
} from "./rooms";
import { defaultGameId, gameCatalog, type GameId } from "./games";
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
  roomTimeControlSchema,
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
    retired: z.literal(true).optional(),
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
    retired: z.literal(true).optional(),
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

export const reversiMatchParticipantSchema = z.discriminatedUnion("kind", [
  matchParticipantSchema.options[0].extend({
    color: reversiColorSchema,
    seat: z.int().min(0).max(1),
  }),
  matchParticipantSchema.options[1].extend({
    color: reversiColorSchema,
    seat: z.int().min(0).max(1),
  }),
]);
export const reversiMatchSummarySchema = z.strictObject({
  id: z.uuid(),
  game: z.literal("reversi"),
  mode: z.never().optional(),
  startedAtMs: z.int().nonnegative(),
  endedAtMs: z.int().nonnegative(),
  participants: z.array(reversiMatchParticipantSchema).length(2),
  result: reversiResultSchema,
});
export type ReversiMatchSummary = z.infer<typeof reversiMatchSummarySchema>;
export const reversiAccountStatsSchema = z
  .strictObject({
    total: matchCount(),
    wins: matchCount(),
    losses: matchCount(),
    draws: matchCount(),
  })
  .refine((s) => s.total === s.wins + s.losses + s.draws);
function matchCount() {
  return z.int().nonnegative();
}
export type ReversiAccountStats = z.infer<typeof reversiAccountStatsSchema>;
export const shogiMatchParticipantSchema = z.discriminatedUnion("kind", [
  fourShogiMatchParticipantSchema.options[0].extend({
    side: shogiSideSchema,
    seat: z.int().min(0).max(1),
  }),
  fourShogiMatchParticipantSchema.options[1].extend({
    side: shogiSideSchema,
    seat: z.int().min(0).max(1),
  }),
]);
function completeStandardShogiParticipants(players: z.infer<typeof shogiMatchParticipantSchema>[]) {
  return [players.map((p) => p.id), players.map((p) => p.side), players.map((p) => p.seat)].every(
    (values) => new Set<string | number>(values).size === 2,
  );
}
export const shogiMatchSummarySchema = reversiMatchSummarySchema
  .extend({
    game: z.literal("shogi"),
    participants: z.array(shogiMatchParticipantSchema).length(2),
    result: finishedShogiStateSchema.shape.result,
  })
  .refine((m) => completeStandardShogiParticipants(m.participants));
export const shogiAccountStatsSchema = reversiAccountStatsSchema;
export type ShogiAccountStats = ReversiAccountStats;
export type ShogiMatchSummary = z.infer<typeof shogiMatchSummarySchema>;
export const gomokuMatchSummarySchema = reversiMatchSummarySchema.extend({
  game: z.literal("gomoku"),
  result: gomokuResultSchema,
});
export type GomokuMatchSummary = z.infer<typeof gomokuMatchSummarySchema>;
export const gomokuMatchParticipantSchema = reversiMatchParticipantSchema;
export const gomokuAccountStatsSchema = reversiAccountStatsSchema;
export type GomokuAccountStats = ReversiAccountStats;
export const fourGomokuMatchSummarySchema = z
  .strictObject({
    ...fourReversiMatchSummarySchema.shape,
    game: z.literal("four-gomoku"),
    result: fourGomokuResultSchema,
  })
  .refine((m) => m.mode === m.result.mode);
export type FourGomokuMatchSummary = z.infer<typeof fourGomokuMatchSummarySchema>;
export const fourGomokuMatchParticipantSchema = matchParticipantSchema;
export type FourGomokuAccountStats = FourReversiAccountStats;
export const matchSummarySchema = z.union([
  fourReversiMatchSummarySchema,
  fourShogiMatchSummarySchema,
  reversiMatchSummarySchema,
  shogiMatchSummarySchema,
  gomokuMatchSummarySchema,
  fourGomokuMatchSummarySchema,
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
  query: z
    .object({
      game: matchGameSchema.default(defaultGameId),
      mode: roomModeSchema.optional(),
      cursor: matchCursorSchema.optional(),
    })
    .refine((value) =>
      gameCatalog[value.game].hasModes ? value.mode !== undefined : value.mode === undefined,
    ),
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
  | FourShogiMatchHistoryParticipant
  | z.infer<typeof reversiMatchParticipantSchema>
  | z.infer<typeof shogiMatchParticipantSchema>;
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
  singles: fourReversiAccountStatsSchema.shape.singles
    .safeExtend({
      knockouts: matchCountSchema,
      perfectWins: matchCountSchema,
    })
    .refine((stats) => stats.perfectWins <= stats.first),
});
export const fourShogiFormationStatsSchema = z
  .array(
    fourReversiAccountStatsSchema.shape.singles
      .safeExtend({ id: z.string().min(1).max(64) })
      .refine((stats) => stats.total > 0),
  )
  .max(16)
  .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length);
export const getFourShogiFormationStatsContract = {
  method: "GET",
  path: "/account/four-shogi/formation-stats",
  response: fourShogiFormationStatsSchema,
} as const;
export type FourShogiFormationStats = z.infer<typeof fourShogiFormationStatsSchema>;
export const accountStatsSchema = z.union([
  fourReversiAccountStatsSchema,
  fourShogiAccountStatsSchema,
  reversiAccountStatsSchema,
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
    settings: fourReversiRoomSettingsSchema.extend({
      timeControl: roomTimeControlSchema.nullable(),
    }),
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
    settings: fourShogiRoomSettingsSchema.extend({
      timeControl: roomTimeControlSchema.nullable(),
    }),
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

export const publicReversiMatchDetailSchema = z
  .strictObject({
    id: z.uuid(),
    roomId: roomCodeSchema,
    startedAtMs: z.int().nonnegative(),
    endedAtMs: z.int().nonnegative(),
    settings: reversiSettingsSchema,
    participants: z.array(reversiMatchParticipantSchema).length(2),
    game: reversiFinishedStateSchema,
    eliminations: z.array(reversiEliminationSchema).max(1),
    replay: reversiReplaySchema,
  })
  .refine(
    (m) =>
      m.replay.id === m.id &&
      new Set(m.participants.map((p) => p.id)).size === 2 &&
      new Set(m.participants.map((p) => p.color)).size === 2 &&
      new Set(m.participants.map((p) => p.seat)).size === 2,
  );
export const reversiMatchDetailSchema = publicReversiMatchDetailSchema
  .safeExtend({ selfPlayerId: z.uuid() })
  .refine((m) => m.participants.some((p) => p.id === m.selfPlayerId));
export type ReversiMatchDetail = z.infer<typeof reversiMatchDetailSchema>;
export type PublicReversiMatchDetail = z.infer<typeof publicReversiMatchDetailSchema>;
export type ReplayReversiMatch = PublicReversiMatchDetail & { selfPlayerId?: string };
export function isReversiMatch(match: ReplayMatch): match is ReplayReversiMatch {
  return match.settings.game === "reversi";
}
export const publicGomokuMatchDetailSchema = z
  .strictObject({
    id: z.uuid(),
    roomId: roomCodeSchema,
    startedAtMs: z.int().nonnegative(),
    endedAtMs: z.int().nonnegative(),
    settings: gomokuSettingsSchema,
    participants: z.array(reversiMatchParticipantSchema).length(2),
    game: gomokuFinishedStateSchema,
    eliminations: z.array(reversiEliminationSchema).max(1),
    replay: gomokuReplaySchema,
  })
  .refine(
    (m) =>
      m.replay.id === m.id &&
      m.game.forbiddenRules === m.settings.forbiddenRules &&
      m.replay.initial.forbiddenRules === m.settings.forbiddenRules &&
      new Set(m.participants.map((p) => p.id)).size === 2 &&
      new Set(m.participants.map((p) => p.color)).size === 2 &&
      new Set(m.participants.map((p) => p.seat)).size === 2,
  );
export const gomokuMatchDetailSchema = publicGomokuMatchDetailSchema
  .safeExtend({ selfPlayerId: z.uuid() })
  .refine((m) => m.participants.some((p) => p.id === m.selfPlayerId));
export type GomokuMatchDetail = z.infer<typeof gomokuMatchDetailSchema>;
export type PublicGomokuMatchDetail = z.infer<typeof publicGomokuMatchDetailSchema>;
export type ReplayGomokuMatch = PublicGomokuMatchDetail & { selfPlayerId?: string };
export function isGomokuMatch(match: ReplayMatch): match is ReplayGomokuMatch {
  return match.settings.game === "gomoku";
}
export const publicFourGomokuMatchDetailSchema = z
  .strictObject({
    id: z.uuid(),
    roomId: roomCodeSchema,
    startedAtMs: z.int().nonnegative(),
    endedAtMs: z.int().nonnegative(),
    settings: fourGomokuSettingsSchema,
    participants: z.array(matchParticipantSchema).length(4),
    game: fourGomokuFinishedStateSchema,
    eliminations: z.array(eliminationSchema).max(3),
    replay: fourGomokuReplaySchema,
  })
  .refine(
    (m) =>
      m.replay.id === m.id &&
      m.game.mode === m.settings.mode &&
      m.replay.initial.mode === m.settings.mode &&
      new Set(m.participants.map((p) => p.id)).size === 4 &&
      new Set(m.participants.map((p) => p.color)).size === 4 &&
      new Set(m.participants.map((p) => p.seat)).size === 4,
  );
export const fourGomokuMatchDetailSchema = publicFourGomokuMatchDetailSchema
  .safeExtend({ selfPlayerId: z.uuid() })
  .refine((m) => m.participants.some((p) => p.id === m.selfPlayerId));
export type FourGomokuMatchDetail = z.infer<typeof fourGomokuMatchDetailSchema>;
export type PublicFourGomokuMatchDetail = z.infer<typeof publicFourGomokuMatchDetailSchema>;
export type ReplayFourGomokuMatch = PublicFourGomokuMatchDetail & { selfPlayerId?: string };
export function isFourGomokuMatch(match: ReplayMatch): match is ReplayFourGomokuMatch {
  return match.settings.game === "four-gomoku";
}
export const publicShogiMatchDetailSchema = z
  .strictObject({
    id: z.uuid(),
    roomId: roomCodeSchema,
    startedAtMs: z.int().nonnegative(),
    endedAtMs: z.int().nonnegative(),
    settings: shogiSettingsSchema,
    participants: z.array(shogiMatchParticipantSchema).length(2),
    game: finishedShogiStateSchema,
    replay: z.strictObject({
      rulesVersion: z.literal(1),
      initial: shogiReplayInitialSchema,
      eventCount: z.int().nonnegative(),
    }),
  })
  .refine(
    (m) =>
      completeStandardShogiParticipants(m.participants) &&
      m.participants.every(
        (p) => m.game.players[p.side] === p.id && m.replay.initial.players[p.side] === p.id,
      ),
  );
export const shogiMatchDetailSchema = publicShogiMatchDetailSchema
  .safeExtend({ selfPlayerId: z.uuid() })
  .refine((m) => m.participants.some((p) => p.id === m.selfPlayerId));
export type ShogiMatchDetail = z.infer<typeof shogiMatchDetailSchema>;
export type PublicShogiMatchDetail = z.infer<typeof publicShogiMatchDetailSchema>;
export type ReplayShogiMatch = PublicShogiMatchDetail & { selfPlayerId?: string };
export function isShogiMatch(match: ReplayMatch): match is ReplayShogiMatch {
  return match.settings.game === "shogi";
}
export const publicMatchDetailSchema = z.union([
  publicFourReversiMatchDetailSchema,
  publicFourShogiMatchDetailSchema,
  publicReversiMatchDetailSchema,
  publicShogiMatchDetailSchema,
  publicGomokuMatchDetailSchema,
  publicFourGomokuMatchDetailSchema,
]);
export type PublicMatchDetail = z.infer<typeof publicMatchDetailSchema>;
export type PublicFourReversiMatchDetail = z.infer<typeof publicFourReversiMatchDetailSchema>;
export type PublicFourShogiMatchDetail = z.infer<typeof publicFourShogiMatchDetailSchema>;
export type ReplayFourReversiMatch = PublicFourReversiMatchDetail & { selfPlayerId?: string };
export type ReplayFourShogiMatch = PublicFourShogiMatchDetail & { selfPlayerId?: string };
export type ReplayMatch =
  | ReplayFourReversiMatch
  | ReplayFourShogiMatch
  | ReplayReversiMatch
  | ReplayShogiMatch
  | ReplayGomokuMatch
  | ReplayFourGomokuMatch;
export const listPublicMatchesContract = {
  method: "GET",
  path: "/matches",
  query: z.object({
    game: matchGameSchema,
    humanOnly: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  }),
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
  reversiMatchDetailSchema,
  shogiMatchDetailSchema,
  gomokuMatchDetailSchema,
  fourGomokuMatchDetailSchema,
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

const fourShogiMatchReplayPageSchema = z.strictObject({
  matchId: z.uuid(),
  rulesVersion: z.literal(1),
  initial: fourShogiReplayInitialSchema,
  eventCount: z.int().nonnegative(),
  events: z
    .array(z.strictObject({ index: z.int().nonnegative(), event: fourShogiReplayEventSchema }))
    .max(100),
  nextCursor: z.int().nonnegative().nullable(),
});
export const shogiMatchReplayPageSchema = fourShogiMatchReplayPageSchema.extend({
  initial: shogiReplayInitialSchema,
  events: z
    .array(z.strictObject({ index: z.int().nonnegative(), event: shogiReplayEventSchema }))
    .max(100),
});
export type FourShogiMatchReplayPage = z.infer<typeof fourShogiMatchReplayPageSchema>;
export type ShogiMatchReplayPage = z.infer<typeof shogiMatchReplayPageSchema>;
export const getMatchReplayContract = {
  method: "GET",
  path: "/account/matches/:matchId/replay",
  pathFor: (id: string) => `/account/matches/${id}/replay`,
  params: getMatchContract.params,
  query: z.object({
    cursor: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().nonnegative()).default(0),
  }),
  response: z.union([fourShogiMatchReplayPageSchema, shogiMatchReplayPageSchema]),
} as const;
export type MatchReplayPage = FourShogiMatchReplayPage;

export const getPublicMatchReplayContract = {
  ...getMatchReplayContract,
  path: "/matches/:matchId/replay",
  pathFor: (id: string) => `/matches/${id}/replay`,
} as const;

export const fourGomokuAccountStatsSchema = fourReversiAccountStatsSchema;
