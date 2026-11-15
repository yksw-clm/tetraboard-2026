import type { GameDefinition } from "@tetraboard/game-contract";
import { gomokuDefinition, type GomokuTypes } from "@tetraboard/gomoku/definition";
import { fourGomokuDefinition, type FourGomokuTypes } from "@tetraboard/four-gomoku/definition";
import type { GameId } from "@tetraboard/protocol";

import { reversiDefinition, type ReversiTypes } from "@tetraboard/reversi/definition";

import { fourReversiDefinition, type FourReversiTypes } from "@tetraboard/four-reversi/definition";

interface DefinitionTypes {
  "four-reversi": FourReversiTypes;
  "four-gomoku": FourGomokuTypes;
  reversi: ReversiTypes;
  gomoku: GomokuTypes;
}

type GameDefinitions = Partial<{
  [G in GameId]: G extends keyof DefinitionTypes ? GameDefinition<DefinitionTypes[G], G> : never;
}>;

export const gameDefinitions = {
  "four-reversi": fourReversiDefinition,
  "four-gomoku": fourGomokuDefinition,
  reversi: reversiDefinition,
  gomoku: gomokuDefinition,
} satisfies GameDefinitions;
