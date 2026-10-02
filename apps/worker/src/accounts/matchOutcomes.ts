/** Both archives keep final results in the same location; participant directions differ. */
export function matchOutcomesCte(personal: boolean): string {
  return `WITH own_matches AS (
    SELECT h.account_id, m.mode, m.game, m.record_json,
      json_extract(m.record_json, '$.game.result') AS result,
      (SELECT CASE WHEN m.game = 'four-reversi' THEN json_extract(p.value, '$.color')
        ELSE json_extract(p.value, '$.side') END
       FROM json_each(m.record_json, '$.participants') p
       WHERE json_extract(p.value, '$.kind') = 'human'
         AND json_extract(p.value, '$.accountId') = h.account_id) AS direction
    FROM account_match_history h JOIN matches m ON m.id = h.match_id
    WHERE h.game = ? AND m.game = h.game ${personal ? "AND h.account_id = ?" : ""}
  ), outcomes AS (
    SELECT account_id, mode,
      (SELECT json_extract(s.value, '$.rank')
       FROM json_each(result, '$.standings') s
       WHERE CASE WHEN game = 'four-reversi' THEN json_extract(s.value, '$.color')
         ELSE json_extract(s.value, '$.side') END = own_matches.direction) AS rank,
      json_extract(result, '$.winner') AS winner,
      CASE WHEN game = 'four-reversi' THEN
        CASE WHEN direction IN ('black', 'red') THEN 'black-red' ELSE 'white-blue' END
      ELSE CASE WHEN direction IN ('south', 'north') THEN 'south-north' ELSE 'west-east' END
      END AS team,
      CASE WHEN game = 'four-shogi' AND mode = 'singles'
        THEN COALESCE(json_extract(record_json, '$.knockouts.' || direction), 0)
        ELSE 0 END AS knockouts
    FROM own_matches
  )`;
}
