import type { GameId } from "@tetraboard/protocol";
import type { AdapterDependencies, AdapterInstance } from "./types";
import { createFourGomokuAdapter } from "./fourGomoku";
import { createGomokuAdapter } from "./gomoku";
import { createFourReversiAdapter } from "./fourReversi";
import { createReversiAdapter } from "./reversi";
import { createFourShogiAdapter } from "./fourShogi";
import { createShogiAdapter } from "./shogi";

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
