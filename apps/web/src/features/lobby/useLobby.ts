import { defaultGameId, type GameId } from "@tetraboard/protocol/games";
import { useGeneralLobbyRooms } from "./useGeneralLobbyRooms";

export function useLobby(game: GameId = defaultGameId) {
  const page = useGeneralLobbyRooms(game);
  return { ...page, isInitialLoading: !page.loaded };
}
