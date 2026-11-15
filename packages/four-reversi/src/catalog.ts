import type { GameCatalog } from "@tetraboard/game-contract";
import type { Color, GameMode } from "./engine";

export type FourReversiSettings = { mode: GameMode };

export const fourReversiCatalog = {
  id: "four-reversi",
  seats: ["black", "white", "red", "blue"],
  rating: "skill",
  defaultSettings: { mode: "singles" },
} as const satisfies GameCatalog<"four-reversi", Color, FourReversiSettings>;
