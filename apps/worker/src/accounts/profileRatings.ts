import {
  ratedMatchmakingRules,
  type GameId,
  type ProfileRating,
  type ProfileRatings,
  type RatedMatchmakingGame,
} from "@tetraboard/protocol";
import { ratedMatchmakingPolicy, type QueueRatingSource } from "../matchmaking/ratedMatchmaking";
import { publicRatingForMu } from "../rooms/fourReversiRating";
import type { DecodedMatch } from "./matchDataContracts";

export function hasProfileRating(game: GameId): game is RatedMatchmakingGame {
  return game === "shogi" || game === "reversi" || game === "four-shogi" || game === "four-reversi";
}

export async function readProfileRating(
  db: D1Database,
  accountId: string,
  game: RatedMatchmakingGame,
  timing: "current" | "before",
): Promise<ProfileRating> {
  const row = await ratedMatchmakingPolicy(game)
    .store.latest(db, accountId)
    .first<{ rating_after: number; rated_games: number; human_games: number }>();
  if (!row || row.rated_games < ratedMatchmakingRules[game].placementGames)
    return { timing, status: "placement" };
  return {
    timing,
    status: "rated",
    ...(timing === "current" ? { humanPlayed: row.human_games > 0 } : {}),
    rating:
      game === "shogi" || game === "reversi"
        ? row.rating_after
        : publicRatingForMu(row.rating_after),
  };
}

export function cpuReferenceRating(source: QueueRatingSource): ProfileRating | undefined {
  const rating =
    source.kind === "cpu"
      ? source.referenceRating
      : source.kind === "reversi"
        ? source.source.kind === "cpu"
          ? source.source.referenceRating
          : undefined
        : source.kind === "four-shogi" || source.kind === "four-reversi"
          ? source.cpu
            ? publicRatingForMu(source.cpu.mu)
            : undefined
          : undefined;
  return rating === undefined ? undefined : { timing: "reference", status: "rated", rating };
}

export const profileRatingsKey = (matchId: string) => `profile-ratings:${matchId}`;

export function savedProfileRatings(storage: DurableObjectStorage, matchId: string) {
  const profileRatings = storage.kv.get<ProfileRatings>(profileRatingsKey(matchId));
  return profileRatings ? { profileRatings } : {};
}

export async function readMatchProfileRating(
  db: D1Database,
  match: DecodedMatch,
  playerId: string,
): Promise<ProfileRating | undefined> {
  if (match.game === "gomoku" || match.game === "four-gomoku") return;
  const record = match.record;
  const source =
    match.game === "shogi" || match.game === "reversi"
      ? match.record.rating
      : match.game === "four-shogi"
        ? match.record.fourShogiRating
        : match.record.fourReversiRating;
  if (!source) return;
  const player = record.participants.find((p) => p.id === playerId);
  if (!player || (player.kind === "human" && player.retired)) return;
  if ("profileRatings" in record && record.profileRatings?.[playerId])
    return record.profileRatings[playerId];
  if (player.kind === "cpu") {
    if (match.game === "shogi" || match.game === "reversi") {
      const rating = match.record.rating;
      return rating?.kind === "cpu"
        ? { timing: "reference", status: "rated", rating: rating.referenceRating }
        : undefined;
    }
    const mu =
      match.game === "four-shogi"
        ? match.record.fourShogiRating?.cpu[
            match.record.participants.find((p) => p.id === playerId)!.side
          ]?.mu
        : match.record.fourReversiRating?.cpu[
            match.record.participants.find((p) => p.id === playerId)!.color
          ]?.mu;
    return mu === undefined
      ? undefined
      : { timing: "reference", status: "rated", rating: publicRatingForMu(mu) };
  }
  if (!player.accountId) return;
  const ranked = match.game === "four-shogi" || match.game === "four-reversi";
  const store = ratedMatchmakingPolicy(match.game).store;
  const row = await db
    .prepare(
      `SELECT ${ranked ? "mu_before" : "rating_before"} AS rating, rated_games
      FROM ${store.changesTable} WHERE match_id=? AND account_id=?`,
    )
    .bind(record.id, player.accountId)
    .first<{ rating: number; rated_games: number }>();
  if (!row) return { timing: "before", status: "unavailable" };
  if (row.rated_games <= ratedMatchmakingRules[match.game].placementGames)
    return { timing: "before", status: "placement" };
  return {
    timing: "before",
    status: "rated",
    rating: ranked ? publicRatingForMu(row.rating) : row.rating,
  };
}
