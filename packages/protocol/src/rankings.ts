import { z } from "zod";
import { usernameSchema } from "./accounts";
import { countCharacters } from "./rooms";

export const rankingEntrySchema = z.strictObject({
  rank: z.int().positive(),
  username: usernameSchema,
  name: z.string().refine((name) => countCharacters(name) >= 1 && countCharacters(name) <= 10),
  avatarUrl: z
    .string()
    .regex(/^\/api\/avatars\/[0-9a-f-]{36}$/)
    .nullable(),
  value: z.int().positive(),
});
const rankingListSchema = z.array(rankingEntrySchema).max(10);
export const fourReversiRankingsSchema = z.strictObject({
  singles: z.strictObject({ first: rankingListSchema, total: rankingListSchema }),
  doubles: z.strictObject({ wins: rankingListSchema, total: rankingListSchema }),
});
export const getFourReversiRankingsContract = {
  method: "GET",
  path: "/games/four-reversi/rankings",
  response: fourReversiRankingsSchema,
} as const;
export type RankingEntry = z.infer<typeof rankingEntrySchema>;
export type FourReversiRankings = z.infer<typeof fourReversiRankingsSchema>;
export const fourShogiRankingsSchema = fourReversiRankingsSchema;
export const getFourShogiRankingsContract = {
  method: "GET",
  path: "/games/four-shogi/rankings",
  response: fourShogiRankingsSchema,
} as const;
export type FourShogiRankings = z.infer<typeof fourShogiRankingsSchema>;
