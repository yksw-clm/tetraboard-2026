import { defaultGameId } from "@tetraboard/protocol/games";
import { Hono } from "hono";
import {
  getFourReversiRankingsContract,
  getFourShogiRankingsContract,
  type MatchGame,
  type FourReversiRankings,
  type RoomMode,
} from "@tetraboard/protocol";
import { profileAvatarUrl } from "../accounts/auth";
import { matchOutcomesCte } from "../accounts/matchOutcomes";

export async function readGameRankings(
  db: D1Database,
  game: MatchGame = defaultGameId,
): Promise<FourReversiRankings> {
  // 保存済みの結果を一度集計し、同順位の判定と人数制限を別々に扱います。
  const rows = await db
    .prepare(`${matchOutcomesCte(false)}, totals AS (
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
    SELECT m.mode, m.metric, m.value, u.username, u.name, u.avatarKey,
      RANK() OVER (PARTITION BY m.mode, m.metric ORDER BY m.value DESC) AS rank,
      ROW_NUMBER() OVER (
        PARTITION BY m.mode, m.metric ORDER BY m.value DESC, u.username ASC
      ) AS position
    FROM metrics m JOIN user u ON u.id = m.account_id
    WHERE m.value > 0 AND u.profileCompleted = 1 AND u.username IS NOT NULL
      AND COALESCE(u.isAnonymous, 0) = 0
  )
  SELECT mode, metric, value, username, name, avatarKey, rank
  FROM ranked WHERE position <= 10 ORDER BY mode, metric, position`)
    .bind(game)
    .all<{
      mode: RoomMode;
      metric: "first" | "wins" | "total";
      value: number;
      username: string;
      name: string;
      avatarKey: string | null;
      rank: number;
    }>();
  const rankings: FourReversiRankings = {
    singles: { first: [], total: [] },
    doubles: { wins: [], total: [] },
  };
  for (const row of rows.results) {
    const entry = {
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
  return getFourReversiRankingsContract.response.parse(rankings);
}

export const rankingRoutes = new Hono<{ Bindings: Env }>();
for (const [game, contract] of [
  ["four-reversi", getFourReversiRankingsContract],
  ["four-shogi", getFourShogiRankingsContract],
] as const) {
  rankingRoutes.get(contract.path, async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await readGameRankings(c.env.APP_DB, game));
    } catch {
      console.error("Game rankings request failed", game);
      return c.json({ message: "ランキングを取得できませんでした。もう一度お試しください。" }, 503);
    }
  });
}
