import {
  gameRankingContracts,
  previewRankingsSchema,
  previewReversiRankingsSchema,
  ratedMatchmakingGameIds,
  ratingRankingContracts,
} from "@tetraboard/protocol";
import { gameIds, gameCatalog } from "@tetraboard/protocol/games";
import { Hono } from "hono";
import {
  queryGameRankings,
  queryTwoPlayerRankings,
  rankingReaders,
  readRatingRankings,
} from "../adapters/rating/rankingReaders";

export const rankingRoutes = new Hono<{ Bindings: Env }>();
for (const game of ratedMatchmakingGameIds) {
  rankingRoutes.get(ratingRankingContracts[game].path, async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await readRatingRankings(c.env.APP_DB, game));
    } catch {
      console.error("Rating rankings request failed", game);
      return c.json(
        { message: "レートランキングを取得できませんでした。もう一度お試しください。" },
        503,
      );
    }
  });
}

for (const game of gameIds) {
  const contract = gameRankingContracts[game];
  rankingRoutes.get(contract.path, async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const preview = c.req.query("profilePreview");
      const knockoutQuery = c.req.query("includeKnockouts");
      if (knockoutQuery !== undefined && (knockoutQuery !== "1" || game !== "four-shogi"))
        return c.json({ message: "取得条件が正しくありません。" }, 400);
      const includeKnockouts = knockoutQuery === "1";
      if (preview !== undefined && preview !== "1")
        return c.json({ message: "取得条件が正しくありません。" }, 400);
      if (preview && !gameCatalog[game].hasModes)
        return c.json(
          previewReversiRankingsSchema.parse(
            await queryTwoPlayerRankings(
              c.env.APP_DB,
              true,
              game as "reversi" | "shogi" | "gomoku",
            ),
          ),
        );
      if (preview)
        return c.json(
          previewRankingsSchema.parse(
            await queryGameRankings(c.env.APP_DB, game, true, includeKnockouts),
          ),
        );
      if (includeKnockouts)
        return c.json(
          gameRankingContracts["four-shogi"].response.parse(
            await queryGameRankings(c.env.APP_DB, "four-shogi", false, true),
          ),
        );
      return c.json(await rankingReaders[game](c.env.APP_DB));
    } catch {
      console.error("Game rankings request failed", game);
      return c.json({ message: "ランキングを取得できませんでした。もう一度お試しください。" }, 503);
    }
  });
}
