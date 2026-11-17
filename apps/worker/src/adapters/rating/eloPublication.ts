import {
  eloCalculation,
  type EloArithmetic,
  type EloGame,
  type eloPolicy,
  type TimeControl,
} from "@tetraboard/context-rating";
import { ratingStatements } from "./tables";
// 同じ batch の棋譜を読む SQL に、文脈で決めた計算条件を渡します。
export function eloChanges(
  db: D1Database,
  game: EloGame,
  matchId: string,
  policy: typeof eloPolicy,
  clocks: TimeControl[],
) {
  const store = ratingStatements(game);
  const side = game === "shogi" ? "side" : "color";
  return db
    .prepare(
      ratedMatch(game, clocks, store.unappliedMatch) +
        players(game, side, store.changesTable, policy.initialRating) +
        changes(game, store.changesTable, policy),
    )
    .bind(matchId);
}
function ratedMatch(game: EloGame, clocks: TimeControl[], unappliedMatch: string) {
  return `WITH rated_match AS MATERIALIZED (
        SELECT record_json,
          json_extract(record_json, '$.game.result.winner') AS winner,
          json_extract(record_json, '$.rating.kind') AS opponent_kind,
          json_extract(record_json, '$.rating.referenceRating') AS cpu_rating
        FROM matches
        WHERE id = ?1 AND game = '${game}'
          AND (${clocks
            .map(
              (
                time,
              ) => `(json_extract(record_json, '$.settings.timeControl.mainTimeMs') = ${time.mainTimeMs}
                AND json_extract(record_json, '$.settings.timeControl.byoyomiMs') = ${time.byoyomiMs})`,
            )
            .join(" OR ")})
          AND json_extract(record_json, '$.rating.usedFallback') IS NULL
          AND ${unappliedMatch}
`;
}
function players(game: EloGame, side: string, changesTable: string, eloInitialRating: number) {
  return `      ), participants AS MATERIALIZED (
        SELECT json_extract(p.value, '$.${side}') AS side,
          json_extract(p.value, '$.kind') AS kind,
          json_extract(p.value, '$.accountId') AS account_id
        FROM rated_match m, json_each(m.record_json, '$.participants') p
      ), players AS MATERIALIZED (
        SELECT p.side, u.id AS account_id,
          COALESCE(r.rating_after, CAST(${eloInitialRating} AS REAL)) AS rating,
          COALESCE(r.rated_games, 0) AS rated_games,
          COALESCE(r.human_games, 0) AS human_games
        FROM participants p
        JOIN user u ON u.id = p.account_id AND COALESCE(u.isAnonymous, 0) = 0
        LEFT JOIN ${changesTable} r ON r.game = '${game}' AND r.account_id = u.id AND r.rated_games = (
          SELECT MAX(rated_games) FROM ${changesTable} WHERE game = '${game}' AND account_id = u.id
        )
        WHERE p.kind = 'human'
          AND NOT EXISTS (SELECT 1 FROM deleted_accounts WHERE id = u.id)
      )
`;
}
function changes(game: EloGame, changesTable: string, policy: typeof eloPolicy) {
  return `      INSERT INTO ${changesTable}
        (game, match_id, account_id, rating_before, rating_after, rated_games, human_games)
      SELECT '${game}', ?1, p.account_id, p.rating,
        ${ratingExpression(policy)},
        p.rated_games + 1, p.human_games + (m.opponent_kind = 'human')
      FROM rated_match m CROSS JOIN players p
      LEFT JOIN players o ON o.side <> p.side
      WHERE (m.opponent_kind = 'human' AND o.account_id <> p.account_id)
        OR (m.opponent_kind = 'cpu' AND EXISTS (SELECT 1 FROM participants WHERE kind = 'cpu'))`;
}

const sqlArithmetic: EloArithmetic<string> = {
  number: (value) => `${value}.0`,
  add: (a, b) => `(${a} + ${b})`,
  subtract: (a, b) => `(${a} - ${b})`,
  multiply: (a, b) => `(${a} * ${b})`,
  divide: (a, b) => `(${a} / ${b})`,
  power: (a, b) => `pow(${a}, ${b})`,
};
function ratingExpression(policy: typeof eloPolicy) {
  const k = `(CASE m.opponent_kind
          WHEN 'human' THEN CASE WHEN p.rated_games < ${policy.placementGames} THEN ${policy.human.placement} ELSE ${policy.human.rated} END
          WHEN 'cpu' THEN CASE WHEN p.rated_games < ${policy.placementGames} THEN ${policy.cpu.placement} ELSE ${policy.cpu.rated} END
        END)`;
  const score = `(CASE WHEN m.winner IS NULL THEN 0.5 WHEN m.winner = p.side THEN 1.0 ELSE 0.0 END)`;
  return eloCalculation(sqlArithmetic, "p.rating", "COALESCE(o.rating, m.cpu_rating)", score, k);
}
