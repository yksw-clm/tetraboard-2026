import { gameIds } from "@tetraboard/protocol/games";
import type { LobbyBoardSources } from "../../build/lobbyBoardAssets";

export const lobbyBoardSources = Object.fromEntries(
  gameIds.map((game) => [game, `/assets/${game === "four-gomoku" ? "gomoku" : game}-fixture.webp`]),
) as LobbyBoardSources;
