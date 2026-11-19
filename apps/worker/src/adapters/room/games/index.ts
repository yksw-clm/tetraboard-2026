import type { GameId } from "@tetraboard/protocol";
import type { AdapterDependencies, AdapterInstance } from "./types";
import { createFourGomokuAdapter } from "./four-gomoku/adapter";
import { createGomokuAdapter } from "./gomoku/adapter";
import { createFourReversiAdapter } from "./four-reversi/adapter";
import { createReversiAdapter } from "./reversi/adapter";
import { createFourShogiAdapter } from "./four-shogi/adapter";
import { createShogiAdapter } from "./shogi/adapter";

export type GameAdapterRegistration = Record<GameId, unknown> & {
  [G in GameId]: { create: (dependencies: AdapterDependencies) => AdapterInstance<G> };
};

export const gameAdapters = {
  "four-gomoku": { create: createFourGomokuAdapter },
  gomoku: { create: createGomokuAdapter },
  "four-reversi": { create: createFourReversiAdapter },
  reversi: { create: createReversiAdapter },
  "four-shogi": { create: createFourShogiAdapter },
  shogi: { create: createShogiAdapter },
} satisfies GameAdapterRegistration;

export function createGameAdapters(dependencies: AdapterDependencies) {
  return {
    "four-gomoku": gameAdapters["four-gomoku"].create(dependencies),
    gomoku: gameAdapters.gomoku.create(dependencies),
    "four-reversi": gameAdapters["four-reversi"].create(dependencies),
    reversi: gameAdapters.reversi.create(dependencies),
    "four-shogi": gameAdapters["four-shogi"].create(dependencies),
    shogi: gameAdapters.shogi.create(dependencies),
  };
}
