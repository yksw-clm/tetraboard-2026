import { z } from "zod";
import {
  matchmakingQueues,
  ratedMatchmakingRules,
  type RatingOpponent,
  type ShogiRatingResult,
} from "@tetraboard/protocol";
import { createRatingStore } from "../matchmaking/ratingStore";

export const eloInitialRating = 1500;

export const eloRatingSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human") }),
  z.strictObject({
    kind: z.literal("cpu"),
    profileId: z.string().min(1),
    referenceRating: z.number(),
    usedFallback: z.literal(true).optional(),
  }),
]);
export type EloRatingSource = z.infer<typeof eloRatingSourceSchema>;

export function createEloRating(
  game: "shogi" | "reversi",
  resultSchema: { parse(value: unknown): ShogiRatingResult },
) {
  const store = createRatingStore(game, `${game}_rating_pending`, `${game}_rating_changes`);
  const rules = matchmakingQueues[game];
  const { placementGames } = ratedMatchmakingRules[game];
  const side = game === "shogi" ? "side" : "color";
  async function readResult(
    db: D1Database,
    accountId: string,
    matchId: string,
    includeOpponent: boolean,
  ) {
    const row = await db
      .prepare(`
    SELECT 'saved' AS phase, json_extract(m.record_json, '$.rating.usedFallback') AS fallback,
      r.rating_before, r.rating_after, r.rated_games, r.human_games,
      CASE WHEN ?3 = 1 THEN json_extract(m.record_json, '$.rating.referenceRating') END AS cpu_rating,
      o.rating_before AS opponent_before, o.rating_after AS opponent_after,
      o.rated_games AS opponent_games
    FROM account_match_history h JOIN matches m ON m.id = h.match_id
    LEFT JOIN ${store.changesTable} r ON r.account_id = h.account_id AND r.match_id = m.id
    LEFT JOIN ${store.changesTable} o ON ?3 = 1 AND o.match_id = m.id AND o.account_id <> h.account_id
    WHERE h.account_id = ?1 AND m.id = ?2 AND m.game = '${game}'
      AND json_extract(m.record_json, '$.rating.kind') IS NOT NULL
    UNION ALL
    SELECT 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    FROM ${store.pendingTable} WHERE account_id = ?1 AND match_id = ?2
  `)
      .bind(accountId, matchId, Number(includeOpponent))
      .first<{
        phase: "saved" | "pending";
        fallback: number | null;
        rating_before: number | null;
        rating_after: number | null;
        rated_games: number | null;
        human_games: number | null;
        cpu_rating: number | null;
        opponent_before: number | null;
        opponent_after: number | null;
        opponent_games: number | null;
      }>();
    if (!row) return null;
    if (row.phase === "pending") return resultSchema.parse({ status: "pending" });
    if (row.rated_games === null)
      return resultSchema.parse({
        status: "excluded",
        reason: row.fallback ? "ai_fallback" : "unavailable",
      });
    let opponent: RatingOpponent | undefined;
    if (row.cpu_rating !== null) {
      opponent = { status: "cpu", rating: row.cpu_rating };
    } else if (
      row.opponent_games !== null &&
      row.opponent_after !== null &&
      row.opponent_before !== null
    ) {
      opponent =
        row.opponent_games < placementGames
          ? { status: "placement" }
          : { status: "rated", rating: row.opponent_after, previousRating: row.opponent_before };
    }
    if (row.rated_games < placementGames)
      return resultSchema.parse({ status: "placement", games: row.rated_games, opponent });
    return resultSchema.parse({
      status: "rated",
      rating: row.rating_after,
      previousRating: row.rating_before,
      humanPlayed: (row.human_games ?? 0) > 0,
      placementCompleted: row.rated_games === placementGames,
      opponent,
    });
  }

  function readLatest(db: D1Database, accountId: string) {
    return store
      .latest(db, accountId)
      .first<{ rating_after: number; rated_games: number; human_games: number }>();
  }

  async function readPublic(db: D1Database, accountId: string) {
    const row = await readLatest(db, accountId);
    if (row && row.rated_games >= placementGames)
      return { rating: row.rating_after, humanPlayed: row.human_games > 0 };
  }

  async function readSummary(db: D1Database, accountId: string) {
    const row = await readLatest(db, accountId);
    return row && row.rated_games >= placementGames
      ? { status: "rated" as const, rating: row.rating_after }
      : { status: "placement" as const, games: row?.rated_games ?? 0 };
  }

  /** 両者の更新前レートを確定してから、対局ごとの更新履歴をまとめて挿入します。 */
  function statement(db: D1Database, matchId: string): D1PreparedStatement {
    return db
      .prepare(
        `WITH rated_match AS MATERIALIZED (
        SELECT record_json,
          json_extract(record_json, '$.game.result.winner') AS winner,
          json_extract(record_json, '$.rating.kind') AS opponent_kind,
          json_extract(record_json, '$.rating.referenceRating') AS cpu_rating
        FROM matches
        WHERE id = ?1 AND game = '${game}'
          AND json_extract(record_json, '$.settings.timeControl.mainTimeMs') = ${rules.timeControl.mainTimeMs}
          AND json_extract(record_json, '$.settings.timeControl.byoyomiMs') = ${rules.timeControl.byoyomiMs}
          AND json_extract(record_json, '$.rating.usedFallback') IS NULL
          AND ${store.unappliedMatch}
      ), participants AS MATERIALIZED (
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
        LEFT JOIN ${store.changesTable} r ON r.account_id = u.id AND r.rated_games = (
          SELECT MAX(rated_games) FROM ${store.changesTable} WHERE account_id = u.id
        )
        WHERE p.kind = 'human'
          AND NOT EXISTS (SELECT 1 FROM deleted_accounts WHERE id = u.id)
      )
      INSERT INTO ${store.changesTable}
        (match_id, account_id, rating_before, rating_after, rated_games, human_games)
      SELECT ?1, p.account_id, p.rating,
        p.rating + (CASE m.opponent_kind
          WHEN 'human' THEN CASE WHEN p.rated_games < ${placementGames} THEN 64 ELSE 32 END
          WHEN 'cpu' THEN CASE WHEN p.rated_games < ${placementGames} THEN 48 ELSE 16 END
        END) * (
          (CASE WHEN m.winner IS NULL THEN 0.5 WHEN m.winner = p.side THEN 1.0 ELSE 0.0 END)
          - 1.0 / (1.0 + pow(10.0, (COALESCE(o.rating, m.cpu_rating) - p.rating) / 400.0))
        ),
        p.rated_games + 1, p.human_games + (m.opponent_kind = 'human')
      FROM rated_match m CROSS JOIN players p
      LEFT JOIN players o ON o.side <> p.side
      WHERE (m.opponent_kind = 'human' AND o.account_id <> p.account_id)
        OR (m.opponent_kind = 'cpu' AND EXISTS (SELECT 1 FROM participants WHERE kind = 'cpu'))`,
      )
      .bind(matchId);
  }
  return { store, readResult, readPublic, readSummary, statement };
}
