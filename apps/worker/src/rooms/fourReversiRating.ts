import { z } from "zod";
import { colors } from "@tetraboard/four-reversi";
import {
  fourReversiRankDivisions,
  fourReversiRankTiers,
  fourReversiRatingResultSchema,
  type RatingOpponent,
} from "@tetraboard/protocol";
import { createRatingStore } from "../matchmaking/ratingStore";
import {
  fourReversiPlacementGames,
  fourReversiRatingMethod,
  initialFourReversiRating,
  rateFourReversi,
} from "../../../../packages/ai/fourReversiRating";
import type { MatchRecord } from "./matchStore";

const cpuRating = z.strictObject({
  mu: z.number(),
  sigma: z.number().positive(),
  profileId: z.string().min(1),
  profileHash: z.string().min(1),
});
export type FourReversiCpuRating = z.infer<typeof cpuRating>;
export const fourReversiRatingStore = createRatingStore(
  "four-reversi",
  "four_reversi_rating_pending",
  "four_reversi_rating_changes",
  "mu_after AS rating_after, sigma_after",
);
export const fourReversiRatedMatchSchema = z.strictObject({
  method: z.literal(fourReversiRatingMethod),
  calibrationVersion: z.string().min(1),
  cpu: z.partialRecord(z.enum(colors), cpuRating),
  usedFallback: z.literal(true).optional(),
});
export type FourReversiRatedMatch = z.infer<typeof fourReversiRatedMatchSchema>;

type CurrentRating = {
  account_id: string;
  mu: number;
  sigma: number;
  rated_games: number;
  human_games: number;
};

export function fourReversiPublicRating(mu: number) {
  const rating = Math.round(1500 + 50 * (mu - initialFourReversiRating.mu));
  const divisions = fourReversiRankDivisions.length;
  const lastRank = fourReversiRankTiers.length * divisions - 1;
  const rankIndex = Math.min(lastRank, Math.max(0, 1 + Math.floor((rating - 1200) / 100)));
  const tier = fourReversiRankTiers[Math.floor(rankIndex / divisions)]!;
  const division = fourReversiRankDivisions[rankIndex % divisions]!;
  return { rating, rank: `${tier}${division}` as const };
}

export async function readFourReversiRatingSummary(db: D1Database, accountId: string) {
  const row = await db
    .prepare(`SELECT mu_after AS mu, rated_games, human_games FROM four_reversi_rating_changes
      WHERE account_id=? ORDER BY rated_games DESC LIMIT 1`)
    .bind(accountId)
    .first<Pick<CurrentRating, "mu" | "rated_games" | "human_games">>();
  if (!row || row.rated_games < fourReversiPlacementGames)
    return { status: "placement" as const, games: row?.rated_games ?? 0 };
  return {
    status: "rated" as const,
    ...fourReversiPublicRating(row.mu),
    humanPlayed: row.human_games > 0,
  };
}

export async function readFourReversiRatingResult(
  db: D1Database,
  accountId: string,
  matchId: string,
  includeOpponents: boolean,
) {
  const { results } = await db
    .prepare(`
    SELECT json_extract(p.value, '$.id') AS player_id,
      json_extract(p.value, '$.accountId') = ?1 AS own,
      json_extract(m.record_json, '$.fourReversiRating.usedFallback') AS fallback,
      json_extract(m.record_json, '$.fourReversiRating.cpu.' || json_extract(p.value, '$.color') || '.mu') AS cpu_mu,
      r.mu_before, r.mu_after, r.rated_games, r.human_games,
      EXISTS(SELECT 1 FROM four_reversi_rating_pending WHERE account_id=?1 AND match_id=?2) AS pending
    FROM account_match_history h JOIN matches m ON m.id=h.match_id
    JOIN json_each(m.record_json, '$.participants') p
    LEFT JOIN four_reversi_rating_changes r
      ON r.match_id=m.id AND r.account_id=json_extract(p.value, '$.accountId')
    WHERE h.account_id=?1 AND m.id=?2 AND m.game='four-reversi'
      AND json_extract(m.record_json, '$.fourReversiRating.method') IS NOT NULL
    UNION ALL
    SELECT NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, 1
    FROM four_reversi_rating_pending WHERE account_id=?1 AND match_id=?2
  `)
    .bind(accountId, matchId)
    .all<{
      player_id: string | null;
      own: number | null;
      fallback: number | null;
      cpu_mu: number | null;
      mu_before: number | null;
      mu_after: number | null;
      rated_games: number | null;
      human_games: number | null;
      pending: number;
    }>();
  if (results.some((row) => row.pending))
    return fourReversiRatingResultSchema.parse({ status: "pending" });
  const own = results.find((row) => row.own);
  if (!own) return null;
  if (own.mu_after === null || own.mu_before === null || own.rated_games === null)
    return fourReversiRatingResultSchema.parse({
      status: "excluded",
      reason: own.fallback ? "ai_fallback" : "unavailable",
    });
  const players: Record<string, RatingOpponent> = {};
  if (includeOpponents)
    for (const row of results) {
      if (!row.player_id || row.own) continue;
      if (row.cpu_mu !== null)
        players[row.player_id] = {
          status: "cpu",
          rating: fourReversiPublicRating(row.cpu_mu).rating,
        };
      else if (row.rated_games !== null && row.mu_after !== null && row.mu_before !== null)
        players[row.player_id] =
          row.rated_games < fourReversiPlacementGames
            ? { status: "placement" }
            : {
                status: "rated",
                rating: fourReversiPublicRating(row.mu_after).rating,
                previousRating: fourReversiPublicRating(row.mu_before).rating,
              };
    }
  if (own.rated_games < fourReversiPlacementGames)
    return fourReversiRatingResultSchema.parse({
      status: "placement",
      games: own.rated_games,
      players,
    });
  return fourReversiRatingResultSchema.parse({
    status: "rated",
    rating: fourReversiPublicRating(own.mu_after).rating,
    previousRating: fourReversiPublicRating(own.mu_before).rating,
    humanPlayed: (own.human_games ?? 0) > 0,
    placementCompleted: own.rated_games === fourReversiPlacementGames,
    players,
  });
}

/** 保存済みの対局と更新前の全参加者の状態を使って、レートをまとめて確定します。 */
export async function applyFourReversiRating(db: D1Database, record: MatchRecord) {
  const source = record.fourReversiRating;
  const result = record.game.result;
  const clock = record.settings.timeControl;
  if (
    !source ||
    source.usedFallback ||
    result.mode !== "singles" ||
    record.settings.mode !== "singles" ||
    clock?.mainTimeMs !== 180_000 ||
    clock.byoyomiMs !== 0
  )
    return;
  const players = record.participants;
  const humans = players.filter((player) => player.kind === "human");
  const ids = humans.map((player) => player.accountId);
  const cpus = players.filter((player) => player.kind === "cpu");
  const ranks = players.map(
    (player) => result.standings.find(({ color }) => color === player.color)?.rank,
  );
  if (
    players.length !== 4 ||
    new Set(players.map(({ color }) => color)).size !== 4 ||
    ranks.some((rank) => rank === undefined) ||
    !ids.length ||
    ids.some((id) => !id) ||
    new Set(ids).size !== ids.length ||
    cpus.length !== Object.keys(source.cpu).length ||
    cpus.some(({ color, cpuProfile }) => {
      const reference = source.cpu[color];
      return (
        !reference ||
        !cpuProfile ||
        reference.profileId !== cpuProfile.id ||
        reference.profileHash !== cpuProfile.hash
      );
    })
  )
    return;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (
      await db
        .prepare("SELECT 1 FROM four_reversi_rating_changes WHERE match_id=?")
        .bind(record.id)
        .first()
    )
      return;
    const { results } = await db
      .prepare(`
      SELECT u.id AS account_id, COALESCE(r.mu_after, ?2) AS mu, COALESCE(r.sigma_after, ?3) AS sigma,
        COALESCE(r.rated_games, 0) AS rated_games, COALESCE(r.human_games, 0) AS human_games
      FROM json_each(?1) ids JOIN user u ON u.id=ids.value
      LEFT JOIN four_reversi_rating_changes r ON r.account_id=u.id AND r.rated_games=(
        SELECT MAX(rated_games) FROM four_reversi_rating_changes WHERE account_id=u.id
      )
      WHERE COALESCE(u.isAnonymous, 0)=0 AND NOT EXISTS (SELECT 1 FROM deleted_accounts WHERE id=u.id)
    `)
      .bind(JSON.stringify(ids), initialFourReversiRating.mu, initialFourReversiRating.sigma)
      .all<CurrentRating>();
    if (results.length !== humans.length) return;
    const before = new Map(results.map((row) => [row.account_id, row]));
    const ratings = players.map((player) =>
      player.kind === "human" ? before.get(player.accountId!)! : source.cpu[player.color]!,
    );
    const updated = rateFourReversi(ratings, ranks as number[]);
    const changes = players.flatMap((player, index) => {
      if (player.kind !== "human") return [];
      const row = before.get(player.accountId!)!;
      return [
        {
          accountId: row.account_id,
          muBefore: row.mu,
          sigmaBefore: row.sigma,
          muAfter: updated[index]!.mu,
          sigmaAfter: updated[index]!.sigma,
          ratedGames: row.rated_games + 1,
          humanGames: row.human_games + Number(humans.length > 1),
        },
      ];
    });
    const saved = await db
      .prepare(`
      WITH changes AS MATERIALIZED (SELECT value AS row FROM json_each(?2))
      INSERT INTO four_reversi_rating_changes
        (match_id, account_id, mu_before, sigma_before, mu_after, sigma_after, rated_games, human_games)
      SELECT ?1, row->>'$.accountId', row->>'$.muBefore', row->>'$.sigmaBefore',
        row->>'$.muAfter', row->>'$.sigmaAfter', row->>'$.ratedGames', row->>'$.humanGames'
      FROM changes
      WHERE NOT EXISTS (SELECT 1 FROM four_reversi_rating_changes WHERE match_id=?1)
        AND NOT EXISTS (
          SELECT 1 FROM changes c WHERE c.row->>'$.ratedGames' - 1 <> COALESCE((
            SELECT MAX(r.rated_games) FROM four_reversi_rating_changes r WHERE r.account_id=c.row->>'$.accountId'
          ), 0) OR NOT EXISTS (
            SELECT 1 FROM user u WHERE u.id=c.row->>'$.accountId' AND COALESCE(u.isAnonymous, 0)=0
              AND NOT EXISTS (SELECT 1 FROM deleted_accounts WHERE id=u.id)
          )
        )
    `)
      .bind(record.id, JSON.stringify(changes))
      .run();
    if (saved.meta.changes === humans.length) return;
  }
  throw Error("四人リバーシのレート更新を再試行してください");
}
