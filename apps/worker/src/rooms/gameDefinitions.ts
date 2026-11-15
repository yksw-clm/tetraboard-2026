import type { GameDefinition } from "@tetraboard/game-contract";
import { gomokuDefinition, type GomokuTypes } from "@tetraboard/gomoku/definition";
import type { GameId } from "@tetraboard/protocol";

interface DefinitionTypes {
  gomoku: GomokuTypes;
}

type GameDefinitions = Partial<{
  [G in GameId]: G extends keyof DefinitionTypes ? GameDefinition<DefinitionTypes[G], G> : never;
}>;

export const gameDefinitions = {
  gomoku: gomokuDefinition,
} satisfies GameDefinitions;
