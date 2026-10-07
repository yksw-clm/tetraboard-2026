import { defaultGameId, gameIds, type GameId } from "@tetraboard/protocol/games";
import { Hono } from "hono";
import {
  gameRankingContracts,
  type RankingsFor,
  type MatchGame,
  type RoomMode,
  type PreviewRankings,
  previewRankingsSchema,
} from "@tetraboard/protocol";
import { ensurePublicProfileId } from "../accounts/currentProfiles";
import { profileAvatarUrl } from "../accounts/auth";
import { matchDataContracts } from "../accounts/matchDataContracts";
import { matchOutcomesCte } from "../accounts/matchOutcomes";

async function queryGameRankings(
  db: D1Database,
  game: MatchGame = defaultGameId,
  preview = false,
): Promise<PreviewRankings> {
  // 保存済みの結果を一度集計し、同順位の判定と人数制限を別々に扱います。
  const rows = await db
    .prepare(`${matchOutcomesCte(game, false)}, totals AS (
    SELECT account_id, mode, COUNT(*) AS total,
      SUM(CASE WHEN mode = 'singles' AND rank = 1 THEN 1
        WHEN mode = 'doubles' AND winner = team THEN 1 ELSE 0 END) AS victories
    FROM outcomes GROUP BY account_id, mode
  ), metrics AS (
    SELECT account_id, mode, 'total' AS metric, total AS value FROM totals
    UNION ALL
    SELECT account_id, mode,
      CASE WHEN mode = 'singles' THEN 'first' ELSE 'wins' END AS metric,
      victories AS value FROM totals
  ), ranked AS (
    SELECT u.id AS accountId, u.publicProfileId, m.mode, m.metric, m.value, u.username, u.name, u.avatarKey,
      RANK() OVER (PARTITION BY m.mode, m.metric ORDER BY m.value DESC) AS rank,
      ROW_NUMBER() OVER (
        PARTITION BY m.mode, m.metric ORDER BY m.value DESC, u.username ASC
      ) AS position
    FROM metrics m JOIN user u ON u.id = m.account_id
    WHERE m.value > 0 AND u.profileCompleted = 1 AND u.username IS NOT NULL
      AND COALESCE(u.isAnonymous, 0) = 0
  )
  SELECT accountId, publicProfileId, mode, metric, value, username, name, avatarKey, rank
  FROM ranked WHERE position <= 10 ORDER BY mode, metric, position`)
    .bind(game)
    .all<{
      accountId: string;
      publicProfileId: string | null;
      mode: RoomMode;
      metric: "first" | "wins" | "total";
      value: number;
      username: string;
      name: string;
      avatarKey: string | null;
      rank: number;
    }>();
  const rankings: PreviewRankings = {
    singles: { first: [], total: [] },
    doubles: { wins: [], total: [] },
  };
  const ids = new Map<string, string>();
  if (preview) {
    for (const row of rows.results) {
      if (ids.has(row.accountId)) continue;
      const id = row.publicProfileId ?? (await ensurePublicProfileId(db, row.accountId));
      if (id) ids.set(row.accountId, id);
    }
  }
  for (const row of rows.results) {
    const entry = {
      ...(preview ? { profileId: ids.get(row.accountId) } : {}),
      rank: row.rank,
      username: row.username,
      name: row.name,
      avatarUrl: profileAvatarUrl(row.avatarKey),
      value: row.value,
    };
    if (row.metric === "total") rankings[row.mode].total.push(entry);
    else if (row.mode === "singles" && row.metric === "first") rankings.singles.first.push(entry);
    else if (row.mode === "doubles" && row.metric === "wins") rankings.doubles.wins.push(entry);
  }
  return rankings;
}

export const rankingRoutes = new Hono<{ Bindings: Env }>();
export const rankingReaders = {
  "four-reversi": async (db: D1Database) =>
    matchDataContracts["four-reversi"].rankings(await queryGameRankings(db, "four-reversi")),
  "four-shogi": async (db: D1Database) =>
    matchDataContracts["four-shogi"].rankings(await queryGameRankings(db, "four-shogi")),
} satisfies { [G in GameId]: (db: D1Database) => Promise<RankingsFor<G>> };
export async function readGameRankings(
  db: D1Database,
  game: MatchGame = defaultGameId,
): Promise<RankingsFor<GameId>> {
  switch (game) {
    case "four-reversi":
      return rankingReaders[game](db);
    case "four-shogi":
      return rankingReaders[game](db);
    default: {
      const exhaustive: never = game;
      throw new Error(`Unsupported ranking game: ${exhaustive}`);
    }
  }
}

for (const game of gameIds) {
  const contract = gameRankingContracts[game];
  rankingRoutes.get(contract.path, async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const preview = c.req.query("profilePreview");
      if (preview !== undefined && preview !== "1")
        return c.json({ message: "取得条件が正しくありません。" }, 400);
      if (preview)
        return c.json(
          previewRankingsSchema.parse(await queryGameRankings(c.env.APP_DB, game, true)),
        );
      return c.json(await rankingReaders[game](c.env.APP_DB));
    } catch {
      console.error("Game rankings request failed", game);
      return c.json({ message: "ランキングを取得できませんでした。もう一度お試しください。" }, 503);
    }
  });
}
