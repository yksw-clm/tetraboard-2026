import { gameCatalog } from "./games";
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
  path: gameCatalog["four-reversi"].rankingsPath,
  response: fourReversiRankingsSchema,
} as const;
export type RankingEntry = z.infer<typeof rankingEntrySchema>;
export type FourReversiRankings = z.infer<typeof fourReversiRankingsSchema>;
export const fourShogiRankingsSchema = fourReversiRankingsSchema;
export const getFourShogiRankingsContract = {
  method: "GET",
  path: gameCatalog["four-shogi"].rankingsPath,
  response: fourShogiRankingsSchema,
} as const;
export type FourShogiRankings = z.infer<typeof fourShogiRankingsSchema>;

export type GameRankingContracts = {
  [G in import("./games").GameId]: {
    method: "GET";
    path: (typeof gameCatalog)[G]["rankingsPath"];
    response: z.ZodType<import("./gameTypes").RankingsFor<G>>;
  };
};
export const reversiRankingsSchema = z.strictObject({
  wins: rankingListSchema,
  total: rankingListSchema,
});
export type ReversiRankings = z.infer<typeof reversiRankingsSchema>;
export const gameRankingContracts = {
  gomoku: { method: "GET", path: gameCatalog.gomoku.rankingsPath, response: reversiRankingsSchema },
  "four-reversi": getFourReversiRankingsContract,
  "four-shogi": getFourShogiRankingsContract,
  shogi: { method: "GET", path: gameCatalog.shogi.rankingsPath, response: reversiRankingsSchema },
  reversi: {
    method: "GET",
    path: gameCatalog.reversi.rankingsPath,
    response: reversiRankingsSchema,
  },
} satisfies GameRankingContracts;
