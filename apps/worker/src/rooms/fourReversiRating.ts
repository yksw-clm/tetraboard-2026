import { z } from "zod";
import { sides } from "@tetraboard/four-shogi";
import type { ShogiMatchRecord } from "./shogiMatchStore";
import { colors } from "@tetraboard/four-reversi";
import { fourReversiRatingResultSchema, type RatingOpponent } from "@tetraboard/protocol";
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

const shogiCpuRating = cpuRating
  .omit({ profileHash: true })
  .extend({ engineVersion: z.string().min(1) });
export const fourShogiRatedMatchSchema = fourReversiRatedMatchSchema.extend({
  cpu: z.partialRecord(z.enum(sides), shogiCpuRating),
});
export type FourShogiRatedMatch = z.infer<typeof fourShogiRatedMatchSchema>;
export const fourShogiRatingStore = createRatingStore(
  "four-shogi",
  "four_shogi_rating_pending",
  "four_shogi_rating_changes",
  "mu_after AS rating_after, sigma_after",
);
const rankRatingStorage = {
  "four-reversi": { store: fourReversiRatingStore, key: "fourReversiRating", seat: "color" },
  "four-shogi": { store: fourShogiRatingStore, key: "fourShogiRating", seat: "side" },
};
type RankGame = keyof typeof rankRatingStorage;

type CurrentRating = {
  account_id: string;
  mu: number;
  sigma: number;
  rated_games: number;
  human_games: number;
};

export const publicRatingBase = 1500;
export const publicRatingScale = 50;

export function publicRatingForMu(mu: number) {
  return Math.round(publicRatingBase + publicRatingScale * (mu - initialFourReversiRating.mu));
}

export const readFourReversiRatingSummary = (db: D1Database, accountId: string) =>
  readRankSummary(db, accountId, "four-reversi");
export const readFourShogiRatingSummary = (db: D1Database, accountId: string) =>
  readRankSummary(db, accountId, "four-shogi");
async function readRankSummary(db: D1Database, accountId: string, game: RankGame) {
  const { store } = rankRatingStorage[game];
  const row = await db
    .prepare(`SELECT mu_after AS mu, rated_games, human_games FROM ${store.changesTable}
      WHERE account_id=? ORDER BY rated_games DESC LIMIT 1`)
    .bind(accountId)
    .first<Pick<CurrentRating, "mu" | "rated_games" | "human_games">>();
  if (!row || row.rated_games < fourReversiPlacementGames)
    return { status: "placement" as const, games: row?.rated_games ?? 0 };
  return {
    status: "rated" as const,
    rating: publicRatingForMu(row.mu),
    humanPlayed: row.human_games > 0,
  };
}

export const readFourReversiRatingResult = (
  db: D1Database,
  accountId: string,
  matchId: string,
  includeOpponents: boolean,
) => readRankResult(db, accountId, matchId, includeOpponents, "four-reversi");
export const readFourShogiRatingResult = (
  db: D1Database,
  accountId: string,
  matchId: string,
  includeOpponents: boolean,
) => readRankResult(db, accountId, matchId, includeOpponents, "four-shogi");
async function readRankResult(
  db: D1Database,
  accountId: string,
  matchId: string,
  includeOpponents: boolean,
  game: RankGame,
) {
  const { store, key, seat } = rankRatingStorage[game];
  const { results } = await db
    .prepare(`
    SELECT json_extract(p.value, '$.id') AS player_id,
      json_extract(p.value, '$.accountId') = ?1 AS own,
      json_extract(m.record_json, '$.${key}.usedFallback') AS fallback,
      json_extract(m.record_json, '$.${key}.cpu.' || json_extract(p.value, '$.${seat}') || '.mu') AS cpu_mu,
      r.mu_before, r.mu_after, r.rated_games, r.human_games,
      EXISTS(SELECT 1 FROM ${store.pendingTable} WHERE account_id=?1 AND match_id=?2) AS pending
    FROM account_match_history h JOIN matches m ON m.id=h.match_id
    JOIN json_each(m.record_json, '$.participants') p
    LEFT JOIN ${store.changesTable} r
      ON r.match_id=m.id AND r.account_id=json_extract(p.value, '$.accountId')
    WHERE h.account_id=?1 AND m.id=?2 AND m.game='${game}'
      AND json_extract(m.record_json, '$.${key}.method') IS NOT NULL
    UNION ALL
    SELECT NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, 1
    FROM ${store.pendingTable} WHERE account_id=?1 AND match_id=?2
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
          rating: publicRatingForMu(row.cpu_mu),
        };
      else if (row.rated_games !== null && row.mu_after !== null && row.mu_before !== null)
        players[row.player_id] =
          row.rated_games < fourReversiPlacementGames
            ? { status: "placement" }
            : {
                status: "rated",
                rating: publicRatingForMu(row.mu_after),
                previousRating: publicRatingForMu(row.mu_before),
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
    rating: publicRatingForMu(own.mu_after),
    previousRating: publicRatingForMu(own.mu_before),
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

  await applyRankRating(
    db,
    "four-reversi",
    record.id,
    players.map((player) =>
      player.kind === "human"
        ? { kind: "human", accountId: player.accountId! }
        : { kind: "cpu", reference: source.cpu[player.color]! },
    ),
    ranks as number[],
  );
}

export async function applyFourShogiRating(db: D1Database, record: ShogiMatchRecord) {
  const source = record.fourShogiRating;
  const result = record.game.result;
  const clock = record.settings.timeControl;
  if (
    !source ||
    source.usedFallback ||
    result.mode !== "singles" ||
    record.settings.mode !== "singles" ||
    !record.settings.threePlayerAttackProhibited ||
    clock?.mainTimeMs !== 180_000 ||
    clock.byoyomiMs !== 0
  )
    return;
  const ranks = record.participants.map(
    ({ side }) => result.standings.find((entry) => entry.side === side)?.rank,
  );
  const humans = record.participants.filter((player) => player.kind === "human");
  const ids = humans.map(({ accountId }) => accountId);
  const cpus = record.participants.filter((player) => player.kind === "cpu");
  if (
    record.participants.length !== 4 ||
    new Set(record.participants.map(({ side }) => side)).size !== 4 ||
    ranks.some((rank) => rank === undefined) ||
    !ids.length ||
    ids.some((id) => !id) ||
    new Set(ids).size !== ids.length ||
    cpus.length !== Object.keys(source.cpu).length ||
    cpus.some(({ side }) => !source.cpu[side])
  )
    return;
  await applyRankRating(
    db,
    "four-shogi",
    record.id,
    record.participants.map((player) =>
      player.kind === "human"
        ? { kind: "human", accountId: player.accountId! }
        : { kind: "cpu", reference: source.cpu[player.side]! },
    ),
    ranks as number[],
  );
}

async function applyRankRating(
  db: D1Database,
  game: RankGame,
  matchId: string,
  players: (
    | { kind: "human"; accountId: string }
    | { kind: "cpu"; reference: { mu: number; sigma: number } }
  )[],
  ranks: number[],
) {
  const { store } = rankRatingStorage[game];
  const humans = players.filter((player) => player.kind === "human");
  const ids = humans.map(({ accountId }) => accountId);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (
      await db.prepare(`SELECT 1 FROM ${store.changesTable} WHERE match_id=?`).bind(matchId).first()
    )
      return;
    const { results } = await db
      .prepare(`
      SELECT u.id AS account_id, COALESCE(r.mu_after, ?2) AS mu, COALESCE(r.sigma_after, ?3) AS sigma,
        COALESCE(r.rated_games, 0) AS rated_games, COALESCE(r.human_games, 0) AS human_games
      FROM json_each(?1) ids JOIN user u ON u.id=ids.value
      LEFT JOIN ${store.changesTable} r ON r.account_id=u.id AND r.rated_games=(
        SELECT MAX(rated_games) FROM ${store.changesTable} WHERE account_id=u.id
      )
      WHERE COALESCE(u.isAnonymous, 0)=0 AND NOT EXISTS (SELECT 1 FROM deleted_accounts WHERE id=u.id)
    `)
      .bind(JSON.stringify(ids), initialFourReversiRating.mu, initialFourReversiRating.sigma)
      .all<CurrentRating>();
    if (results.length !== humans.length) return;
    const before = new Map(results.map((row) => [row.account_id, row]));
    const ratings = players.map((player) =>
      player.kind === "human" ? before.get(player.accountId!)! : player.reference,
    );
    const updated = rateFourReversi(ratings, ranks as number[]);
    const maxRatingChange = humans.length < 4 ? 24 : 32;
    const changes = players.flatMap((player, index) => {
      if (player.kind !== "human") return [];
      const row = before.get(player.accountId!)!;
      const next = updated[index]!;
      let muAfter = next.mu;
      if (row.rated_games >= fourReversiPlacementGames) {
        const previousRating = publicRatingForMu(row.mu);
        const change = publicRatingForMu(muAfter) - previousRating;
        if (Math.abs(change) > maxRatingChange) {
          const cappedRating = previousRating + Math.sign(change) * maxRatingChange;
          muAfter =
            initialFourReversiRating.mu + (cappedRating - publicRatingBase) / publicRatingScale;
        }
      }
      return [
        {
          accountId: row.account_id,
          muBefore: row.mu,
          sigmaBefore: row.sigma,
          muAfter,
          sigmaAfter: next.sigma,
          ratedGames: row.rated_games + 1,
          humanGames: row.human_games + Number(humans.length > 1),
        },
      ];
    });
    const saved = await db
      .prepare(`
      WITH changes AS MATERIALIZED (SELECT value AS row FROM json_each(?2))
      INSERT INTO ${store.changesTable}
        (match_id, account_id, mu_before, sigma_before, mu_after, sigma_after, rated_games, human_games)
      SELECT ?1, row->>'$.accountId', row->>'$.muBefore', row->>'$.sigmaBefore',
        row->>'$.muAfter', row->>'$.sigmaAfter', row->>'$.ratedGames', row->>'$.humanGames'
      FROM changes
      WHERE NOT EXISTS (SELECT 1 FROM ${store.changesTable} WHERE match_id=?1)
        AND NOT EXISTS (
          SELECT 1 FROM changes c WHERE c.row->>'$.ratedGames' - 1 <> COALESCE((
            SELECT MAX(r.rated_games) FROM ${store.changesTable} r WHERE r.account_id=c.row->>'$.accountId'
          ), 0) OR NOT EXISTS (
            SELECT 1 FROM user u WHERE u.id=c.row->>'$.accountId' AND COALESCE(u.isAnonymous, 0)=0
              AND NOT EXISTS (SELECT 1 FROM deleted_accounts WHERE id=u.id)
          )
        )
    `)
      .bind(matchId, JSON.stringify(changes))
      .run();
    if (saved.meta.changes === humans.length) return;
  }
  throw Error("4人対局のレート更新を再試行してください");
}
