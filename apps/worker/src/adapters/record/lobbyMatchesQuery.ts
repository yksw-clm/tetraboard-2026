export function lobbyMatchesQuery(humanOnly: boolean) {
  return `SELECT game,record_json FROM matches
 ${
   humanOnly
     ? `WHERE json_array_length(record_json,'$.participants')=CASE WHEN game IN ('reversi','shogi','gomoku') THEN 2 ELSE 4 END
 AND NOT EXISTS(SELECT 1 FROM json_each(record_json,'$.participants') p WHERE json_extract(p.value,'$.kind') IS NOT 'human')`
     : ""
 }
 ORDER BY started_at_ms DESC,id DESC LIMIT 20`;
}
