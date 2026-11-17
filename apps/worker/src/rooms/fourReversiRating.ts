import { z } from "zod";
import { sides } from "@tetraboard/four-shogi";
import { colors } from "@tetraboard/four-reversi";
import { fourReversiRatingResultSchema } from "@tetraboard/protocol";
import {
  fourReversiRatingMethod,
  readRatingSummary,
  readSkillRatingResult,
  type SkillGame,
} from "@tetraboard/context-rating";
import { D1RatingReader } from "../adapters/rating/reader";
import { createRatingStore } from "../adapters/rating/matchmakingStore";
export { publicRatingBase, publicRatingScale, publicRatingForMu } from "@tetraboard/context-rating";
const cpuRating = z.strictObject({
  mu: z.number(),
  sigma: z.number().positive(),
  profileId: z.string().min(1),
  profileHash: z.string().min(1),
});
export type FourReversiCpuRating = z.infer<typeof cpuRating>;
export const fourReversiRatingStore = createRatingStore("four-reversi");
export const fourReversiRatedMatchSchema = z.strictObject({
  method: z.literal(fourReversiRatingMethod),
  calibrationVersion: z.string().min(1),
  cpu: z.partialRecord(z.enum(colors), cpuRating),
  usedFallback: z.literal(true).optional(),
});
export type FourReversiRatedMatch = z.infer<typeof fourReversiRatedMatchSchema>;

const shogiCpuRating = cpuRating
  .omit({ profileHash: true })
  .extend({ engineVersion: z.string().min(1) });
export const fourShogiRatedMatchSchema = fourReversiRatedMatchSchema.extend({
  cpu: z.partialRecord(z.enum(sides), shogiCpuRating),
});
export type FourShogiRatedMatch = z.infer<typeof fourShogiRatedMatchSchema>;
export const fourShogiRatingStore = createRatingStore("four-shogi");

export const readFourReversiRatingSummary = (db: D1Database, accountId: string) =>
  readRatingSummary(new D1RatingReader(db), "four-reversi", accountId);
export const readFourShogiRatingSummary = (db: D1Database, accountId: string) =>
  readRatingSummary(new D1RatingReader(db), "four-shogi", accountId);
export const readFourReversiRatingResult = (
  db: D1Database,
  accountId: string,
  matchId: string,
  includeOpponents: boolean,
) => readRankResult(db, accountId, matchId, includeOpponents, "four-reversi");
export const readFourShogiRatingResult = (
  db: D1Database,
  accountId: string,
  matchId: string,
  includeOpponents: boolean,
) => readRankResult(db, accountId, matchId, includeOpponents, "four-shogi");
async function readRankResult(
  db: D1Database,
  accountId: string,
  matchId: string,
  includeOpponents: boolean,
  game: SkillGame,
) {
  const result = await readSkillRatingResult(
    new D1RatingReader(db),
    game,
    accountId,
    matchId,
    includeOpponents,
  );
  return result === null ? null : fourReversiRatingResultSchema.parse(result);
}
