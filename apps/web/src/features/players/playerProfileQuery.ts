import { getPlayerProfileContract, type PlayerProfileTarget } from "@tetraboard/protocol";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import type { RoomMode } from "@tetraboard/protocol";

export function playerProfileApiUrl(target: PlayerProfileTarget, game: GameId) {
  const query = new URLSearchParams({
    ...target,
    game,
    includeBadges: "1",
    includeStats: "1",
    includeDetails: "1",
    includeRating: "1",
  });
  return `/api${getPlayerProfileContract.path}?${query}`;
}

export function playerGameQuery(game: GameId, mode: RoomMode) {
  const query = new URLSearchParams({ game });
  if (gameCatalog[game].hasModes) query.set("mode", mode);
  return query;
}

export function playerPagePath(profileId: string, game: GameId, mode: RoomMode) {
  return `/players/${profileId}?${playerGameQuery(game, mode)}`;
}
