import type { GameId } from "@tetraboard/protocol/games";

export function matchmakingPath(game: GameId) {
  return game === "shogi" ? "/games/shogi?matchmaking=1" : "/games/four-reversi/matchmaking";
}

export function matchmakingScope(identity: string, game: GameId) {
  return game === "shogi" ? `matchmaking:shogi:${identity}` : `matchmaking:${identity}`;
}
