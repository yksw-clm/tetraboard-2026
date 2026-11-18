import {
  readAccountStats as readStats,
  type OutcomeStatsReader,
  type RankedOutcomeTotals,
} from "@tetraboard/context-record";
import { defaultGameId } from "@tetraboard/protocol/games";
import type { GameId, MatchGame, ReversiAccountStats } from "@tetraboard/protocol";
import { matchDataContracts, type StatsFor } from "./matchDataContracts";
import { matchOutcomesCte } from "./matchOutcomes";

function outcomeStatsReader(db: D1Database): OutcomeStatsReader {
  return {
    async ranked(game, accountId) {
      // 保存済みの結果だけを集計します。再生チャンクは読み取りません。
      const { results } = await db
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
        .all<RankedOutcomeTotals>();
      return results;
    },
    duel: (game, accountId) =>
      db
        .prepare(
          `${matchOutcomesCte(game, true)} SELECT COUNT(*) AS total,COALESCE(SUM(winner=direction),0) AS wins,COALESCE(SUM(winner IS NOT NULL AND winner!=direction),0) AS losses,COALESCE(SUM(winner IS NULL),0) AS draws FROM outcomes`,
        )
        .bind(game, accountId)
        .first<ReversiAccountStats>(),
  };
}

export async function readAccountStats<G extends GameId = "four-reversi">(
  db: D1Database,
  accountId: string,
  game?: G,
): Promise<StatsFor<G>>;
export async function readAccountStats(
  db: D1Database,
  accountId: string,
  game: MatchGame = defaultGameId,
) {
  const stats = await readStats(outcomeStatsReader(db), accountId, game);
  return matchDataContracts[game].stats(stats);
}
