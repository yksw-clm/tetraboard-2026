import { isRatedMatchmakingGame } from "@tetraboard/protocol";
import type { GameId } from "@tetraboard/protocol/games";

export function matchmakingPath(game: GameId) {
  return isRatedMatchmakingGame(game)
    ? `/games/${game}?matchmaking=1`
    : "/games/four-reversi/matchmaking";
}

export function matchmakingScope(identity: string, game: GameId) {
  return isRatedMatchmakingGame(game)
    ? `matchmaking:${game}:${identity}`
    : `matchmaking:${identity}`;
}
