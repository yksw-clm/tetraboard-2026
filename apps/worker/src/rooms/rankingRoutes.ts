import { Hono } from "hono";
import {
  getFourReversiRankingsContract,
  type FourReversiRankings,
  type RoomMode,
} from "@tetraboard/protocol";
import { profileAvatarUrl } from "../accounts/auth";

export async function readFourReversiRankings(db: D1Database): Promise<FourReversiRankings> {
  // 保存済みの結果を一度集計し、同順位の判定と人数制限を別々に扱います。
  const rows = await db
    .prepare(`WITH account_matches AS (
    SELECT h.account_id, m.mode,
      json_extract(m.record_json, '$.game.result') AS result,
      (SELECT json_extract(p.value, '$.color')
       FROM json_each(m.record_json, '$.participants') p
       WHERE json_extract(p.value, '$.kind') = 'human'
         AND json_extract(p.value, '$.accountId') = h.account_id) AS color
    FROM account_match_history h JOIN matches m ON m.id = h.match_id
    WHERE m.game = 'four-reversi'
  ), outcomes AS (
    SELECT account_id, mode,
      (SELECT json_extract(s.value, '$.rank')
       FROM json_each(result, '$.standings') s
       WHERE json_extract(s.value, '$.color') = account_matches.color) AS rank,
      json_extract(result, '$.winner') AS winner,
      CASE WHEN color IN ('black', 'red') THEN 'black-red' ELSE 'white-blue' END AS team
    FROM account_matches
  ), totals AS (
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
rankingRoutes.get(getFourReversiRankingsContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    return c.json(await readFourReversiRankings(c.env.APP_DB));
  } catch {
    console.error("Four reversi rankings request failed");
    return c.json({ message: "ランキングを取得できませんでした。もう一度お試しください。" }, 503);
  }
});
