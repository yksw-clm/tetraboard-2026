import type { GameCatalog } from "@tetraboard/game-contract";
import type { Color, GameMode } from "./index";

export type FourGomokuSettings = { mode: GameMode };

export const fourGomokuCatalog = {
  id: "four-gomoku",
  seats: ["black", "white", "red", "blue"],
  rating: "none",
  defaultSettings: { mode: "singles" },
} as const satisfies GameCatalog<"four-gomoku", Color, FourGomokuSettings>;
