import type { TournamentStanding } from "@tetraboard/protocol";
import type { ScoreRow, InternalStanding } from "./types";
export function standingFromRow(
  v: ScoreRow,
  avatarUrl: (row: ScoreRow) => string | null,
): InternalStanding {
  return {
    entryId: v.entryId,
    accountId: v.deleted ? null : v.accountId,
    rank: v.finalRank,
    name: v.name ?? "退会したプレイヤー",
    username: v.username,
    profileId: v.deleted ? null : v.publicProfileId,
    ...(v.isAnonymous ? { isGuest: true } : {}),
    avatarUrl: v.deleted || !v.name || !v.accountId ? null : avatarUrl(v),
    pointsUnits: v.pointsUnits,
    games: v.games,
    first: v.first,
    second: v.second,
    third: v.third,
    fourth: v.fourth,
    knockouts: v.knockouts,
    rankSum: v.rankSum,
  };
}
export function visibleStanding(
  { entryId: _entry, accountId, profileId, ...score }: InternalStanding,
  viewer?: string,
  includeProfiles = false,
): TournamentStanding {
  return {
    ...score,
    ...(includeProfiles ? { profileId } : {}),
    ...(viewer && accountId === viewer ? { self: true } : {}),
  };
}
