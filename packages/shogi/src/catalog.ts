import type { GameCatalog } from "@tetraboard/game-contract";
import type { InitialStateOptions, Side } from "./types";

export const shogiCatalog = {
  id: "shogi",
  seats: ["south", "north"],
  rating: "elo",
  defaultSettings: { players: { south: "south", north: "north" } },
} as const satisfies GameCatalog<"shogi", Side, InitialStateOptions>;
