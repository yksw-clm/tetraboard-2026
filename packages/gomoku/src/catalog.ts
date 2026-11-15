import type { GameCatalog } from "@tetraboard/game-contract";
import type { Color } from "./index";

export type GomokuSettings = { forbiddenRules: boolean };

export const gomokuCatalog = {
  id: "gomoku",
  seats: ["black", "white"],
  rating: "none",
  defaultSettings: { forbiddenRules: true },
} as const satisfies GameCatalog<"gomoku", Color, GomokuSettings>;
