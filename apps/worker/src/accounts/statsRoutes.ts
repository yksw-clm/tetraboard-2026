import { defaultGameId, type GameId } from "@tetraboard/protocol/games";
import { Hono } from "hono";
import {
  getAccountStatsContract,
  type AccountStats,
  type FourReversiAccountStats,
  type RoomMode,
  type MatchGame,
} from "@tetraboard/protocol";
import { accountIdentity } from "./auth";
import { matchDataContracts, type StatsFor } from "./matchDataContracts";
import { matchOutcomesCte } from "./matchOutcomes";

async function queryAccountStats(
  db: D1Database,
  accountId: string,
  game: MatchGame = defaultGameId,
) {
  // Aggregate committed outcomes only; replay chunks are never loaded here.
  const rows = await db
    .prepare(`${matchOutcomesCte(game, true)}
  SELECT mode, COUNT(*) AS total,
    SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END) AS first,
    SUM(CASE WHEN rank = 2 THEN 1 ELSE 0 END) AS second,
    SUM(CASE WHEN rank = 3 THEN 1 ELSE 0 END) AS third,
    SUM(CASE WHEN rank = 4 THEN 1 ELSE 0 END) AS fourth,
    SUM(CASE WHEN winner = team THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN winner IS NOT NULL AND winner != team THEN 1 ELSE 0 END) AS losses,
    SUM(CASE WHEN winner IS NULL THEN 1 ELSE 0 END) AS draws,
    SUM(knockouts) AS knockouts,
    SUM(CASE WHEN mode = 'singles' AND rank = 1 AND knockouts = 3
      AND json_extract(result, '$.reason') = 'last_player'
      AND (SELECT COUNT(*) FROM json_each(result, '$.standings') s
        WHERE json_extract(s.value, '$.rank') = 1) = 1
      THEN 1 ELSE 0 END) AS perfectWins
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
      perfectWins: number;
    }>();
  const stats: FourReversiAccountStats = {
    singles: {
      total: 0,
      first: 0,
      second: 0,
      third: 0,
      fourth: 0,
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
      };
    } else if (row.mode === "doubles") {
      const { total, wins, losses, draws } = row;
      stats.doubles = { total, wins, losses, draws };
    }
  }
  const singles = rows.results.find((row) => row.mode === "singles");
  return { stats, knockouts: singles?.knockouts ?? 0, perfectWins: singles?.perfectWins ?? 0 };
}

export const statsReaders = {
  "four-reversi": async (db: D1Database, accountId: string) =>
    matchDataContracts["four-reversi"].stats(
      (await queryAccountStats(db, accountId, "four-reversi")).stats,
    ),
  "four-shogi": async (db: D1Database, accountId: string) => {
    const { stats, knockouts, perfectWins } = await queryAccountStats(db, accountId, "four-shogi");
    return matchDataContracts["four-shogi"].stats({
      ...stats,
      singles: { ...stats.singles, knockouts, perfectWins },
    });
  },
} satisfies { [G in GameId]: (db: D1Database, accountId: string) => Promise<StatsFor<G>> };
export async function readAccountStats(
  db: D1Database,
  accountId: string,
  game: MatchGame = defaultGameId,
): Promise<AccountStats> {
  switch (game) {
    case "four-reversi":
      return statsReaders[game](db, accountId);
    case "four-shogi":
      return statsReaders[game](db, accountId);
    default: {
      const exhaustive: never = game;
      throw new Error(`Unsupported stats game: ${exhaustive}`);
    }
  }
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
