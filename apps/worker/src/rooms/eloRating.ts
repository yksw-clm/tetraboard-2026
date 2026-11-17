import { z } from "zod";
import type { ShogiRatingResult } from "@tetraboard/protocol";
import {
  readEloRatingResult,
  readPublicRating,
  readRatingSummary,
  type EloGame,
} from "@tetraboard/context-rating";
import { D1RatingReader } from "../adapters/rating/reader";
import { createRatingStore } from "../adapters/rating/matchmakingStore";
export { eloInitialRating } from "@tetraboard/context-rating";
export const eloRatingSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human") }),
  z.strictObject({
    kind: z.literal("cpu"),
    profileId: z.string().min(1),
    referenceRating: z.number(),
    usedFallback: z.literal(true).optional(),
  }),
]);
export type EloRatingSource = z.infer<typeof eloRatingSourceSchema>;

export function createEloRating(
  game: EloGame,
  resultSchema: { parse(value: unknown): ShogiRatingResult },
) {
  return {
    store: createRatingStore(game),
    readResult: async (
      db: D1Database,
      accountId: string,
      matchId: string,
      includeOpponent: boolean,
    ) => {
      const result = await readEloRatingResult(
        new D1RatingReader(db),
        game,
        accountId,
        matchId,
        includeOpponent,
      );
      return result === null ? null : resultSchema.parse(result);
    },
    readPublic: (db: D1Database, accountId: string) =>
      readPublicRating(new D1RatingReader(db), game, accountId),
    readSummary: (db: D1Database, accountId: string) =>
      readRatingSummary(new D1RatingReader(db), game, accountId),
  };
}
