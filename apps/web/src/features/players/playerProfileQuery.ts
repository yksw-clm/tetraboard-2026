import { getPlayerProfileContract, type PlayerProfileQueryTarget } from "@tetraboard/protocol";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import type { RoomMode } from "@tetraboard/protocol";

export function playerProfileApiUrl(
  target: PlayerProfileQueryTarget,
  game: GameId,
  { includeRating = true } = {},
) {
  const query = new URLSearchParams({
    ...target,
    game,
    includeBadges: "1",
    includeStats: "1",
    includeDetails: "1",
    ...(includeRating ? { includeRating: "1" } : {}),
  });
  return `/api${getPlayerProfileContract.path}?${query}`;
}

export function playerGameQuery(game: GameId, mode: RoomMode) {
  const query = new URLSearchParams({ game });
  if (gameCatalog[game].hasModes) query.set("mode", mode);
  return query;
}

export function playerUsernamePath(username: string) {
  return `/users/@${encodeURIComponent(username)}`;
}

export function playerPagePath(
  profile: { profileId: string; username?: string | null },
  game: GameId,
  mode: RoomMode,
) {
  const path = profile.username
    ? playerUsernamePath(profile.username)
    : `/players/${profile.profileId}`;
  return `${path}?${playerGameQuery(game, mode)}`;
}
