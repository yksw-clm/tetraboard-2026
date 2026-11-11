import { z } from "zod";
import { roomMembershipSchema, roomCodeSchema } from "./rooms";
export const matchmakingRules = {
  key: "four-reversi:singles:v2:180000:0:casual-v1",
  seats: 4,
  fillAfterMs: 30_000,
  heartbeatMs: 10_000,
  leaseMs: 30_000,
  connectionGraceMs: 30_000,
  countdownMs: 5_000,
  timeControl: { mainTimeMs: 180_000, byoyomiMs: 0 },
} as const;
export const shogiMatchmakingRules = {
  ...matchmakingRules,
  key: "shogi:300000:30000:rated-v1",
  seats: 2,
  fillAfterMs: 15_000,
  timeControl: { mainTimeMs: 300_000, byoyomiMs: 30_000 },
} as const;
export const fourReversiRatedMatchmakingRules = {
  ...matchmakingRules,
  key: "four-reversi:singles:v2:180000:0:rated-v1",
  fillAfterMs: 20_000,
} as const;
export const fourShogiRatedMatchmakingRules = {
  ...fourReversiRatedMatchmakingRules,
  key: "four-shogi:singles:v1:180000:0:rated-v1",
} as const;
export const reversiMatchmakingRules = {
  ...shogiMatchmakingRules,
  key: "reversi:180000:0:rated-v1",
  timeControl: { mainTimeMs: 180_000, byoyomiMs: 0 },
} as const;
export const matchmakingQueues = {
  reversi: reversiMatchmakingRules,
  "four-reversi": fourReversiRatedMatchmakingRules,
  "four-shogi": fourShogiRatedMatchmakingRules,
  shogi: shogiMatchmakingRules,
} as const;
export const matchmakingQueueKeys = [
  ...Object.values(matchmakingQueues).map(({ key }) => key),
  matchmakingRules.key,
];
export type MatchmakingGame = keyof typeof matchmakingQueues;
export function isMatchmakingGame(game: string): game is MatchmakingGame {
  return Object.hasOwn(matchmakingQueues, game);
}
export const ratedMatchmakingRules = {
  reversi: { placementGames: 5 },
  shogi: { placementGames: 5 },
  "four-reversi": { placementGames: 5 },
  "four-shogi": { placementGames: 5 },
} as const satisfies Partial<Record<MatchmakingGame, { placementGames: number }>>;
export type RatedMatchmakingGame = keyof typeof ratedMatchmakingRules;
export function isRatedMatchmakingGame(game: string): game is RatedMatchmakingGame {
  return Object.hasOwn(ratedMatchmakingRules, game);
}
export const shogiPlacementGames = ratedMatchmakingRules.shogi.placementGames;
export const fourReversiRatingSummarySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("placement"),
    games: z.int().nonnegative().lt(ratedMatchmakingRules["four-reversi"].placementGames),
  }),
  // 旧Workerのrankを読み捨て、数値レートだけを取り出す。
  z.object({
    status: z.literal("rated"),
    rating: z.int(),
    humanPlayed: z.boolean(),
  }),
]);
export const ratingSummarySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("placement"),
    games: z.int().nonnegative(),
  }),
  z.strictObject({ status: z.literal("rated"), rating: z.number() }),
]);
const duelSummarySchema = (placementGames: number) =>
  ratingSummarySchema.refine(
    (summary) => summary.status !== "placement" || summary.games < placementGames,
  );
export const shogiRatingSummarySchema = duelSummarySchema(shogiPlacementGames);
export const reversiRatingSummarySchema = duelSummarySchema(
  ratedMatchmakingRules.reversi.placementGames,
);
const publicRatingSchema = z.strictObject({
  rating: z.number(),
  humanPlayed: z.boolean(),
});
export const publicShogiRatingSchema = publicRatingSchema;
export const publicReversiRatingSchema = publicRatingSchema;
const ratingOpponentSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("placement") }),
  z.strictObject({ status: z.literal("rated"), rating: z.number(), previousRating: z.number() }),
  z.strictObject({ status: z.literal("cpu"), rating: z.number() }),
]);
export type RatingOpponent = z.infer<typeof ratingOpponentSchema>;
const pendingRating = z.strictObject({ status: z.literal("pending") });
const excludedRating = z.strictObject({
  status: z.literal("excluded"),
  reason: z.enum(["ai_fallback", "unavailable"]),
});
const placementRating = z.strictObject({
  status: z.literal("placement"),
  games: z.int().positive(),
});
const appliedRating = publicRatingSchema.extend({
  status: z.literal("rated"),
  previousRating: z.number(),
  placementCompleted: z.boolean(),
});
const ratingResultSchema = z.discriminatedUnion("status", [
  pendingRating,
  excludedRating,
  placementRating,
  appliedRating,
]);
export type RatingResult = z.infer<typeof ratingResultSchema>;
const duelResultSchema = (placementGames: number) =>
  z.discriminatedUnion("status", [
    pendingRating,
    excludedRating,
    placementRating.extend({
      games: z.int().positive().lt(placementGames),
      opponent: ratingOpponentSchema.optional(),
    }),
    appliedRating.extend({ opponent: ratingOpponentSchema.optional() }),
  ]);
export const shogiRatingResultSchema = duelResultSchema(shogiPlacementGames);
export const reversiRatingResultSchema = duelResultSchema(
  ratedMatchmakingRules.reversi.placementGames,
);
export type ShogiRatingResult = z.infer<typeof shogiRatingResultSchema>;
export type ReversiRatingResult = z.infer<typeof reversiRatingResultSchema>;
const fourReversiResultPlayers = z.record(z.string(), ratingOpponentSchema);
export const fourReversiRatingResultSchema = z.discriminatedUnion("status", [
  pendingRating,
  excludedRating,
  placementRating.extend({
    games: z.int().positive().lt(ratedMatchmakingRules["four-reversi"].placementGames),
    players: fourReversiResultPlayers,
  }),
  appliedRating.extend({ players: fourReversiResultPlayers }),
]);
export type FourReversiRatingResult = z.infer<typeof fourReversiRatingResultSchema>;
export const matchmakingInputSchema = z.strictObject({
  controllerId: z.uuid(),
  operationId: z.uuid(),
});
export const matchmakingControlSchema = matchmakingInputSchema.extend({
  version: z.int().positive(),
});
export const matchmakingStateSchema = z.strictObject({
  enabled: z.boolean().optional(),
  waitingCount: z.int().nonnegative().optional(),
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
      opponent: z.enum(["human", "cpu"]).optional(),
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
  game: z.enum(["shogi", "four-reversi", "four-shogi", "reversi"]).optional(),
  identity: z.string().min(1),
  roomId: z.string().regex(/^\d{5}$/),
  instanceId: z.uuid(),
});
