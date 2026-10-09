import { isGameId, gameCapacity, type GameId } from "@tetraboard/protocol/games";
export type OutcomeSql = {
  direction: string;
  rankDirection: string;
  team: string;
  knockouts: string;
};
export type OutcomeSqlFor<G extends GameId> = OutcomeSql & { game: G };
export const gameOutcomeSql = {
  "four-reversi": {
    game: "four-reversi",
    direction: "json_extract(p.value, '$.color')",
    rankDirection: "json_extract(s.value, '$.color')",
    team: "CASE WHEN direction IN ('black', 'red') THEN 'black-red' ELSE 'white-blue' END",
    knockouts: "0",
  },
  "four-shogi": {
    game: "four-shogi",
    direction: "json_extract(p.value, '$.side')",
    rankDirection: "json_extract(s.value, '$.side')",
    team: "CASE WHEN direction IN ('south', 'north') THEN 'south-north' ELSE 'west-east' END",
    knockouts:
      "CASE WHEN mode = 'singles' THEN COALESCE(json_extract(record_json, '$.knockouts.' || direction), 0) ELSE 0 END",
  },
} satisfies { [G in GameId]: OutcomeSqlFor<G> };
/** 集計条件は共有し、保存された方向・チームの契約はゲーム別に登録します。 */
export function matchOutcomesCte(game: GameId, personal: boolean): string {
  if (!isGameId(game)) throw new Error("Unsupported match game");
  const sql = gameOutcomeSql[game];
  return `WITH own_matches AS (
    SELECT h.account_id, m.id AS match_id, m.mode, m.game, m.record_json,
      json_extract(m.record_json, '$.game.result') AS result,
      (SELECT ${sql.direction}
       FROM json_each(m.record_json, '$.participants') p
       WHERE json_extract(p.value, '$.kind') = 'human'
         AND json_extract(p.value, '$.accountId') = h.account_id) AS direction
    FROM account_match_history h JOIN matches m ON m.id = h.match_id
    WHERE h.game = ? AND m.game = h.game ${personal ? "AND h.account_id = ?" : ""}
      AND json_array_length(m.record_json, '$.participants') = ${gameCapacity(game)}
      AND NOT EXISTS (
        SELECT 1 FROM json_each(m.record_json, '$.participants') participant
        WHERE json_extract(participant.value, '$.kind') IS NOT 'human'
      )
  ), outcomes AS (
    SELECT account_id, match_id, mode, direction, result,
      (SELECT json_extract(s.value, '$.rank')
       FROM json_each(result, '$.standings') s
       WHERE ${sql.rankDirection} = own_matches.direction) AS rank,
      json_extract(result, '$.winner') AS winner,
      ${sql.team} AS team,
      ${sql.knockouts} AS knockouts
    FROM own_matches
  )`;
}
