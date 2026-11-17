import type { MatchHistoryFilter, MatchKind } from "@tetraboard/protocol";

const rated = `(
  json_type(m.record_json, '$.fourReversiRating') = 'object'
  OR json_type(m.record_json, '$.fourShogiRating') = 'object'
  OR json_type(m.record_json, '$.rating') = 'object'
)`;
const tournament = `EXISTS (SELECT 1 FROM tournament_matches t WHERE t.id = m.id)`;

// 一覧の絞り込みと表示で、同じ成立記録・大会台帳を参照します。
const storedMatchKindSql = `CASE
  WHEN ${tournament} THEN CASE WHEN ${rated} THEN 'unknown' ELSE 'tournament' END
  WHEN ${rated} THEN 'rated'
  ELSE 'normal'
END`;

export function matchHistoryFilterSql(filter: MatchHistoryFilter) {
  if (filter === "all") return "";
  if (filter === "rated") return ` AND (${storedMatchKindSql}) = 'rated'`;
  return ` AND (${storedMatchKindSql}) IN ('normal', 'tournament')
    AND json_array_length(m.record_json, '$.participants') =
      CASE WHEN m.game IN ('four-reversi', 'four-shogi', 'four-gomoku') THEN 4 ELSE 2 END
    AND NOT EXISTS (
      SELECT 1 FROM json_each(m.record_json, '$.participants') p
      WHERE json_extract(p.value, '$.kind') IS NULL
        OR json_extract(p.value, '$.kind') NOT IN ('human', 'cpu')
    )
    AND ${filter === "human" ? "NOT " : ""}EXISTS (
      SELECT 1 FROM json_each(m.record_json, '$.participants') p
      WHERE json_extract(p.value, '$.kind') = 'cpu'
    )`;
}

export async function readMatchKinds(db: D1Database, matchIds: string[]) {
  const kinds = new Map<string, MatchKind>();
  if (!matchIds.length) return kinds;
  const rows = await db
    .prepare(`SELECT m.id, (${storedMatchKindSql}) AS kind FROM matches m
      WHERE m.id IN (${matchIds.map(() => "?").join(",")})`)
    .bind(...matchIds)
    .all<{ id: string; kind: MatchKind }>();
  for (const row of rows.results) kinds.set(row.id, row.kind);
  return kinds;
}
