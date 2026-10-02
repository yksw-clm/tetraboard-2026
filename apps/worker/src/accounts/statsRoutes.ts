import { Hono } from "hono";
import {
  getAccountStatsContract,
  type AccountStats,
  type RoomMode,
  type MatchGame,
} from "@tetraboard/protocol";
import { accountIdentity } from "./auth";
import { matchOutcomesCte } from "./matchOutcomes";

export async function readAccountStats(
  db: D1Database,
  accountId: string,
  game: MatchGame = "four-reversi",
): Promise<AccountStats> {
  // Aggregate committed outcomes only; replay chunks are never loaded here.
  const rows = await db
    .prepare(`${matchOutcomesCte(true)}
  SELECT mode, COUNT(*) AS total,
    SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END) AS first,
    SUM(CASE WHEN rank = 2 THEN 1 ELSE 0 END) AS second,
    SUM(CASE WHEN rank = 3 THEN 1 ELSE 0 END) AS third,
    SUM(CASE WHEN rank = 4 THEN 1 ELSE 0 END) AS fourth,
    SUM(CASE WHEN winner = team THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN winner IS NOT NULL AND winner != team THEN 1 ELSE 0 END) AS losses,
    SUM(CASE WHEN winner IS NULL THEN 1 ELSE 0 END) AS draws,
    SUM(knockouts) AS knockouts
  FROM outcomes GROUP BY mode`)
    .bind(game, accountId)
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
      knockouts: number;
    }>();
  const stats: AccountStats = {
    singles: {
      total: 0,
      first: 0,
      second: 0,
      third: 0,
      fourth: 0,
      ...(game === "four-shogi" ? { knockouts: 0 } : {}),
    },
    doubles: { total: 0, wins: 0, losses: 0, draws: 0 },
  };
  for (const row of rows.results) {
    if (row.mode === "singles") {
      const { total, first, second, third, fourth } = row;
      stats.singles = {
        total,
        first,
        second,
        third,
        fourth,
        ...(game === "four-shogi" ? { knockouts: row.knockouts } : {}),
      };
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
    const query = getAccountStatsContract.query.safeParse({ game: c.req.query("game") });
    if (!query.success) return c.json({ message: "戦績の取得条件が正しくありません。" }, 400);
    return c.json(await readAccountStats(c.env.APP_DB, user.id, query.data.game));
  } catch {
    console.error("Account stats request failed");
    return c.json({ message: "戦績を取得できませんでした。もう一度お試しください。" }, 503);
  }
});
