import type { GameCatalog } from "@tetraboard/game-contract";
import type { InitialStateOptions, Side } from "./types";

export const fourShogiCatalog = {
  id: "four-shogi",
  seats: ["south", "west", "north", "east"],
  rating: "skill",
  defaultSettings: {
    mode: "singles",
    threePlayerAttackProhibited: true,
    players: { south: "south", west: "west", north: "north", east: "east" },
  },
} as const satisfies GameCatalog<"four-shogi", Side, InitialStateOptions>;
