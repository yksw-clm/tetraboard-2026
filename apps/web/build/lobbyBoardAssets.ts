import { gameIds, type GameId } from "@tetraboard/protocol/games";
import type { Manifest } from "vite";

export type LobbyBoardSources = Record<GameId, string>;

export function lobbyBoardSourcesFromManifest(manifest: Manifest): LobbyBoardSources {
  return Object.fromEntries(
    gameIds.map((game) => {
      const source = `src/assets/lobby/${game === "four-gomoku" ? "gomoku" : game}.webp`;
      const asset = manifest[source];
      if (!asset?.file.startsWith("assets/") || !asset.file.endsWith(".webp")) {
        throw new Error(`Missing built lobby board asset: ${source}`);
      }
      return [game, `/${asset.file}`];
    }),
  ) as LobbyBoardSources;
}
