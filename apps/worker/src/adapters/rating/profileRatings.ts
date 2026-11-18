import type { ProfileRating, ProfileRatings, RatedMatchmakingGame } from "@tetraboard/protocol";
import {
  hasProfileRating,
  readProfileRating as readContextProfileRating,
  readMatchProfileRating as readContextMatchProfileRating,
} from "@tetraboard/context-rating";
import { D1RatingReader } from "./reader";
import type { ReadableMatch } from "../record/matchDataContracts";

export async function readProfileRating(
  db: D1Database,
  accountId: string,
  game: RatedMatchmakingGame,
  timing: "current" | "before",
): Promise<ProfileRating> {
  return readContextProfileRating(new D1RatingReader(db), game, accountId, timing);
}

export const profileRatingsKey = (matchId: string) => `profile-ratings:${matchId}`;

export function savedProfileRatings(storage: DurableObjectStorage, matchId: string) {
  const profileRatings = storage.kv.get<ProfileRatings>(profileRatingsKey(matchId));
  return profileRatings ? { profileRatings } : {};
}

export async function readMatchProfileRating(
  db: D1Database,
  match: ReadableMatch,
  playerId: string,
): Promise<ProfileRating | undefined> {
  if (!hasProfileRating(match.game)) return;
  const { game, record } = match;
  const { rated, reference } = matchRatingSource(match, playerId);
  const player = record.participants.find((p) => p.id === playerId);
  return readContextMatchProfileRating(new D1RatingReader(db), {
    game,
    matchId: record.id,
    rated,
    saved: "profileRatings" in record ? record.profileRatings?.[playerId] : undefined,
    player: player?.kind === "cpu" ? { kind: "cpu", reference } : player,
  });
}

function matchRatingSource(match: ReadableMatch, playerId: string) {
  switch (match.game) {
    case "shogi":
    case "reversi": {
      const rating = match.record.rating;
      return {
        rated: !!rating,
        reference: rating?.kind === "cpu" ? { rating: rating.referenceRating } : undefined,
      };
    }
    case "four-shogi": {
      const rating = match.record.fourShogiRating;
      const player = match.record.participants.find((p) => p.id === playerId);
      const mu = player && rating?.cpu[player.side]?.mu;
      return { rated: !!rating, reference: mu === undefined ? undefined : { mu } };
    }
    case "four-reversi": {
      const rating = match.record.fourReversiRating;
      const player = match.record.participants.find((p) => p.id === playerId);
      const mu = player && rating?.cpu[player.color]?.mu;
      return { rated: !!rating, reference: mu === undefined ? undefined : { mu } };
    }
    default:
      return { rated: false };
  }
}
