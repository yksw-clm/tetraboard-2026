import type { GameCatalog } from "@tetraboard/game-contract";
import type { Color } from "./index";

export type ReversiSettings = Record<string, never>;

export const reversiCatalog = {
  id: "reversi",
  seats: ["black", "white"],
  rating: "elo",
  defaultSettings: {},
} as const satisfies GameCatalog<"reversi", Color, ReversiSettings>;
