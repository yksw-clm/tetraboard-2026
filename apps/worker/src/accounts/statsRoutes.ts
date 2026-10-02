import { Hono } from "hono";
import { getAccountStatsContract, type AccountStats, type RoomMode } from "@tetraboard/protocol";
import { accountIdentity } from "./auth";

export async function readAccountStats(db: D1Database, accountId: string): Promise<AccountStats> {
  // Only the persisted result and the account's color are needed; no replay data leaves D1.
  const rows = await db
    .prepare(`WITH own_matches AS (
    SELECT m.mode, json_extract(m.record_json, '$.game.result') AS result,
      (SELECT json_extract(p.value, '$.color')
       FROM json_each(m.record_json, '$.participants') p
       WHERE json_extract(p.value, '$.kind') = 'human'
         AND json_extract(p.value, '$.accountId') = h.account_id) AS color
    FROM account_match_history h JOIN matches m ON m.id = h.match_id
    WHERE h.account_id = ? AND m.game = 'four-reversi'
  ), outcomes AS (
    SELECT mode,
      (SELECT json_extract(s.value, '$.rank')
       FROM json_each(result, '$.standings') s
       WHERE json_extract(s.value, '$.color') = own_matches.color) AS rank,
      json_extract(result, '$.winner') AS winner,
      CASE WHEN color IN ('black', 'red') THEN 'black-red' ELSE 'white-blue' END AS team
    FROM own_matches
  )
  SELECT mode, COUNT(*) AS total,
    SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END) AS first,
    SUM(CASE WHEN rank = 2 THEN 1 ELSE 0 END) AS second,
    SUM(CASE WHEN rank = 3 THEN 1 ELSE 0 END) AS third,
    SUM(CASE WHEN rank = 4 THEN 1 ELSE 0 END) AS fourth,
    SUM(CASE WHEN winner = team THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN winner IS NOT NULL AND winner != team THEN 1 ELSE 0 END) AS losses,
    SUM(CASE WHEN winner IS NULL THEN 1 ELSE 0 END) AS draws
  FROM outcomes GROUP BY mode`)
    .bind(accountId)
    .all<{
      mode: RoomMode;
      total: number;
      first: number;
      second: number;
      third: number;
      fourth: number;
      wins: number;
      losses: number;
      draws: number;
    }>();
  const stats: AccountStats = {
    singles: { total: 0, first: 0, second: 0, third: 0, fourth: 0 },
    doubles: { total: 0, wins: 0, losses: 0, draws: 0 },
  };
  for (const row of rows.results) {
    if (row.mode === "singles") {
      const { total, first, second, third, fourth } = row;
      stats.singles = { total, first, second, third, fourth };
    } else if (row.mode === "doubles") {
      const { total, wins, losses, draws } = row;
      stats.doubles = { total, wins, losses, draws };
    }
  }
  return getAccountStatsContract.response.parse(stats);
}

export const statsRoutes = new Hono<{ Bindings: Env }>();
statsRoutes.get(getAccountStatsContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await accountIdentity(c.req.raw, c.env);
    if (!user) return c.json({ message: "ログインしてください。" }, 401);
    return c.json(await readAccountStats(c.env.APP_DB, user.id));
  } catch {
    console.error("Account stats request failed");
    return c.json({ message: "戦績を取得できませんでした。もう一度お試しください。" }, 503);
  }
});
