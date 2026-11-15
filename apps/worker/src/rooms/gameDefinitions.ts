import type { GameDefinition } from "@tetraboard/game-contract";
import { gomokuDefinition, type GomokuTypes } from "@tetraboard/gomoku/definition";
import { fourGomokuDefinition, type FourGomokuTypes } from "@tetraboard/four-gomoku/definition";
import type { GameId } from "@tetraboard/protocol";

import { reversiDefinition, type ReversiTypes } from "@tetraboard/reversi/definition";

import { fourReversiDefinition, type FourReversiTypes } from "@tetraboard/four-reversi/definition";

import { shogiDefinition, type ShogiTypes } from "@tetraboard/shogi/definition";

import { fourShogiDefinition, type FourShogiTypes } from "@tetraboard/four-shogi/definition";

interface DefinitionTypes {
  "four-shogi": FourShogiTypes;
  shogi: ShogiTypes;
  "four-reversi": FourReversiTypes;
  "four-gomoku": FourGomokuTypes;
  reversi: ReversiTypes;
  gomoku: GomokuTypes;
}

export type GameDefinitions = Record<GameId, unknown> & {
  [G in GameId]: GameDefinition<DefinitionTypes[G], G>;
};

export const gameDefinitions = {
  "four-shogi": fourShogiDefinition,
  shogi: shogiDefinition,
  "four-reversi": fourReversiDefinition,
  "four-gomoku": fourGomokuDefinition,
  reversi: reversiDefinition,
  gomoku: gomokuDefinition,
} satisfies GameDefinitions;
