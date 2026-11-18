import { readFormationStats as readStats } from "@tetraboard/context-record";
import {
  getFourShogiFormationStatsContract,
  type FourShogiFormationStats,
} from "@tetraboard/protocol";
import {
  formationAnalyzerId,
  formationAnalysisVersion,
  formationIds,
} from "@tetraboard/four-shogi";
import { matchOutcomesCte } from "./matchOutcomes";

export async function readFormationStats(
  db: D1Database,
  accountId: string,
): Promise<FourShogiFormationStats> {
  const stats = await readStats(
    {
      async readFormations(accountId) {
        const rows = await db
          .prepare(`${matchOutcomesCte("four-shogi", true)}, used AS (
    SELECT DISTINCT o.rank, o.match_id, used.value AS id
    FROM outcomes o
    JOIN four_shogi_formation_usages f ON f.match_id = o.match_id,
      json_each(f.used_by_side_json, '$.' || o.direction) used
    WHERE o.mode = 'singles' AND f.analyzer_id = ? AND f.analysis_version = ? AND f.rules_version = 1
  )
  SELECT id, COUNT(*) AS total,
    SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END) AS first,
    SUM(CASE WHEN rank = 2 THEN 1 ELSE 0 END) AS second,
    SUM(CASE WHEN rank = 3 THEN 1 ELSE 0 END) AS third,
    SUM(CASE WHEN rank = 4 THEN 1 ELSE 0 END) AS fourth
  FROM used GROUP BY id`)
          .bind("four-shogi", accountId, formationAnalyzerId, formationAnalysisVersion)
          .all<FourShogiFormationStats[number]>();
        return rows.results;
      },
    },
    accountId,
    formationIds,
  );
  return getFourShogiFormationStatsContract.response.parse(stats);
}
