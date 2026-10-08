import { Hono } from "hono";
import {
  getFourShogiFormationStatsContract,
  type FourShogiFormationStats,
} from "@tetraboard/protocol";
import {
  formationAnalyzerId,
  formationAnalysisVersion,
  formationIds,
} from "@tetraboard/four-shogi";
import { accountIdentity } from "./auth";
import { matchOutcomesCte } from "./matchOutcomes";

export async function readFormationStats(
  db: D1Database,
  accountId: string,
): Promise<FourShogiFormationStats> {
  const rows = await db
    .prepare(`${matchOutcomesCte("four-shogi", true)}, used AS (
    SELECT DISTINCT o.rank, o.match_id, used.value AS id
    FROM outcomes o
    JOIN shogi_match_formations f ON f.match_id = o.match_id,
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
  if (rows.results.some((entry) => !formationIds.some((id) => id === entry.id)))
    throw new Error("Unknown Shogi formation ID");
  return getFourShogiFormationStatsContract.response.parse(rows.results);
}

export const formationStatsRoutes = new Hono<{ Bindings: Env }>();
formationStatsRoutes.get(getFourShogiFormationStatsContract.path, async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const user = await accountIdentity(c.req.raw, c.env);
    if (!user) return c.json({ message: "ログインしてください。" }, 401);
    return c.json(await readFormationStats(c.env.APP_DB, user.id));
  } catch {
    console.error("Formation stats request failed");
    return c.json({ message: "戦法別戦績を取得できませんでした。もう一度お試しください。" }, 503);
  }
});
