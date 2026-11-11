import { isRatedMatchmakingGame, type RoomMode } from "@tetraboard/protocol";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";

export function includesRatedStats(game: GameId, mode: RoomMode): boolean {
  return isRatedMatchmakingGame(game) && (!gameCatalog[game].hasModes || mode === "singles");
}

export function statsScopeLabel(game: GameId, mode: RoomMode): string {
  return includesRatedStats(game, mode) ? "対人戦/レート戦を集計" : "対人戦のみ集計";
}

export function formatStatsRate(count: number, total: number): string {
  const rounded = total === 0 ? 0 : Math.round((count * 1000) / total) / 1000;
  return rounded.toFixed(3).replace(/^0\./, ".");
}
