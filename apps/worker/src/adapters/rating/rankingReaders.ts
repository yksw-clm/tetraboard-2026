import {
  ratingRankingContracts,
  type MatchGame,
  type PreviewRankings,
  type PreviewReversiRankings,
  type RankingsFor,
  type RatedMatchmakingGame,
  type RoomMode,
} from "@tetraboard/protocol";
import { defaultGameId, type GameId } from "@tetraboard/protocol/games";
import { readRatingRankings as readContextRatingRankings } from "@tetraboard/context-rating";
import { accountAvatarUrl } from "../../accounts/auth";
import { matchDataContracts } from "../record/matchDataContracts";
import { matchOutcomesCte } from "../record/matchOutcomes";
import { D1RatingReader } from "./reader";

export async function readRatingRankings(db: D1Database, game: RatedMatchmakingGame) {
  const rows = await readContextRatingRankings(new D1RatingReader(db), game);
  return ratingRankingContracts[game].response.parse({
    entries: rows.map((row) => ({
      rank: row.rank,
      profileId: row.profileId,
      username: row.username,
      name: row.name,
      avatarUrl: accountAvatarUrl({
        id: row.accountId,
        avatarKey: row.avatarKey,
        avatarPresetId: row.avatarPresetId,
      }),
      value: row.value,
    })),
  });
}

type GameRankingRow = {
  accountId: string;
  publicProfileId: string | null;
  mode: RoomMode;
  metric: "first" | "wins" | "total" | "knockouts";
  value: number;
  username: string | null;
  isAnonymous: number | null;
  name: string;
  avatarKey: string | null;
  avatarPresetId: string | null;
  rank: number;
};

export async function queryGameRankings(
  db: D1Database,
  game: MatchGame = defaultGameId,
  preview = false,
  includeKnockouts = false,
): Promise<PreviewRankings> {
  // 保存済みの結果を一度集計し、同順位の判定と人数制限を別々に扱います。
  const rows = await db
    .prepare(`${matchOutcomesCte(game, false)}, totals AS (
    SELECT account_id, mode, COUNT(*) AS total,
      SUM(CASE WHEN mode = 'singles' AND rank = 1 THEN 1
        WHEN mode = 'doubles' AND winner = team THEN 1 ELSE 0 END) AS victories,
      SUM(knockouts) AS knockouts
    FROM outcomes GROUP BY account_id, mode
  ), metrics AS (
    SELECT account_id, mode, 'total' AS metric, total AS value FROM totals
    UNION ALL
    SELECT account_id, mode,
      CASE WHEN mode = 'singles' THEN 'first' ELSE 'wins' END AS metric,
      victories AS value FROM totals
    ${includeKnockouts && game === "four-shogi" ? "UNION ALL SELECT account_id, mode, 'knockouts' AS metric, knockouts AS value FROM totals WHERE mode = 'singles'" : ""}
  ), ranked AS (
    SELECT u.id AS accountId, u.publicProfileId, m.mode, m.metric, m.value, u.username, u.name, u.avatarKey,u.avatarPresetId, u.isAnonymous,
      RANK() OVER (PARTITION BY m.mode, m.metric ORDER BY m.value DESC) AS rank,
      ROW_NUMBER() OVER (
        PARTITION BY m.mode, m.metric ORDER BY m.value DESC, u.username ASC
      ) AS position
    FROM metrics m JOIN user u ON u.id = m.account_id
    WHERE m.value > 0 AND u.profileCompleted = 1
      AND (COALESCE(u.isAnonymous,0)=0 OR u.guestNameCustomized=1) AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=u.id) AND NOT EXISTS (SELECT 1 FROM deleted_accounts d WHERE d.id=u.id)
  )
  SELECT accountId, publicProfileId, mode, metric, value, username, name, avatarKey, avatarPresetId, isAnonymous, rank
  FROM ranked WHERE position <= 10 ORDER BY mode, metric, position`)
    .bind(game)
    .all<GameRankingRow>();
  return formatGameRankings(rows.results, preview, includeKnockouts);
}

function formatGameRankings(
  rows: GameRankingRow[],
  preview: boolean,
  includeKnockouts: boolean,
): PreviewRankings {
  const rankings: PreviewRankings = {
    singles: { first: [], total: [], ...(includeKnockouts ? { knockouts: [] } : {}) },
    doubles: { wins: [], total: [] },
  };
  for (const row of rows) {
    if (preview && !row.publicProfileId) throw new Error("Public profile ID is missing");
    const entry = {
      ...(preview ? { profileId: row.publicProfileId! } : {}),
      rank: row.rank,
      username: row.username,
      ...(row.isAnonymous ? { isGuest: true } : {}),
      name: row.name,
      avatarUrl: accountAvatarUrl({
        id: row.accountId,
        avatarKey: row.avatarKey,
        avatarPresetId: row.avatarPresetId,
      }),
      value: row.value,
    };
    if (row.metric === "total") rankings[row.mode].total.push(entry);
    else if (row.mode === "singles" && row.metric === "first") rankings.singles.first.push(entry);
    else if (row.mode === "doubles" && row.metric === "wins") rankings.doubles.wins.push(entry);
    else if (row.mode === "singles" && row.metric === "knockouts")
      rankings.singles.knockouts?.push(entry);
  }
  return rankings;
}

export async function queryTwoPlayerRankings(
  db: D1Database,
  preview = false,
  game: "reversi" | "shogi" | "gomoku" = "reversi",
): Promise<PreviewReversiRankings> {
  const rows = await db
    .prepare(`${matchOutcomesCte(game, false)}, totals AS (
 SELECT account_id,COUNT(*) AS total,COALESCE(SUM(winner=direction),0) AS wins FROM outcomes GROUP BY account_id
 ),metrics AS (SELECT account_id,'total' AS metric,total AS value FROM totals UNION ALL SELECT account_id,'wins' AS metric,wins AS value FROM totals),ranked AS (
 SELECT u.id AS accountId,u.publicProfileId,u.username,u.name,u.avatarKey,u.avatarPresetId,u.isAnonymous,m.metric,m.value,
 RANK() OVER(PARTITION BY m.metric ORDER BY m.value DESC) AS rank,
 ROW_NUMBER() OVER(PARTITION BY m.metric ORDER BY m.value DESC,u.username ASC) AS position
 FROM metrics m JOIN user u ON u.id=m.account_id WHERE m.value>0 AND u.profileCompleted=1  AND (COALESCE(u.isAnonymous,0)=0 OR u.guestNameCustomized=1) AND NOT EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=u.id)
 ) SELECT * FROM ranked WHERE position<=10 ORDER BY metric,position`)
    .bind(game)
    .all<{
      accountId: string;
      publicProfileId: string | null;
      username: string | null;
      isAnonymous: number | null;
      name: string;
      avatarKey: string | null;
      avatarPresetId: string | null;
      metric: "wins" | "total";
      value: number;
      rank: number;
    }>();
  const result: PreviewReversiRankings = { wins: [], total: [] };
  for (const row of rows.results) {
    if (preview && !row.publicProfileId) throw new Error("Public profile ID is missing");
    const profileId = preview ? row.publicProfileId : undefined;
    result[row.metric].push({
      rank: row.rank,
      username: row.username,
      ...(row.isAnonymous ? { isGuest: true } : {}),
      name: row.name,
      avatarUrl: accountAvatarUrl({
        id: row.accountId,
        avatarKey: row.avatarKey,
        avatarPresetId: row.avatarPresetId,
      }),
      value: row.value,
      ...(profileId ? { profileId } : {}),
    });
  }
  return result;
}

export const rankingReaders = {
  gomoku: async (db: D1Database) =>
    matchDataContracts.gomoku.rankings(await queryTwoPlayerRankings(db, false, "gomoku")),
  shogi: async (db: D1Database) =>
    matchDataContracts.shogi.rankings(await queryTwoPlayerRankings(db, false, "shogi")),
  reversi: async (db: D1Database) =>
    matchDataContracts.reversi.rankings(await queryTwoPlayerRankings(db)),
  "four-gomoku": async (db: D1Database) =>
    matchDataContracts["four-gomoku"].rankings(await queryGameRankings(db, "four-gomoku")),
  "four-reversi": async (db: D1Database) =>
    matchDataContracts["four-reversi"].rankings(await queryGameRankings(db, "four-reversi")),
  "four-shogi": async (db: D1Database) =>
    matchDataContracts["four-shogi"].rankings(await queryGameRankings(db, "four-shogi")),
} satisfies { [G in GameId]: (db: D1Database) => Promise<RankingsFor<G>> };
export function readGameRankings<G extends GameId = "four-reversi">(
  db: D1Database,
  game?: G,
): Promise<RankingsFor<G>>;
export async function readGameRankings(
  db: D1Database,
  game: MatchGame = defaultGameId,
): Promise<RankingsFor<GameId>> {
  switch (game) {
    case "shogi":
      return rankingReaders[game](db);
    case "reversi":
      return rankingReaders[game](db);
    case "four-gomoku":
      return rankingReaders[game](db);
    case "gomoku":
      return rankingReaders[game](db);
    case "four-reversi":
      return rankingReaders[game](db);
    case "four-shogi":
      return rankingReaders[game](db);
    default: {
      const exhaustive: never = game;
      throw new Error(`Unsupported ranking game: ${exhaustive}`);
    }
  }
}
