import type { ExternalCpuDefinition } from "@tetraboard/game-contract";
import type { FourReversiTypes } from "./definition";
import { getLegalMoves } from "./engine";

export const fourReversiExternalCpu: Required<ExternalCpuDefinition<FourReversiTypes>> = {
  getPositionKey: (game) =>
    JSON.stringify([
      game.mode,
      game.board,
      game.turn,
      game.moveNumber,
      game.eliminatedColors,
      game.consecutivePasses,
      game.lastMove,
    ]),
  createRequest: (state, _seat, level, options) => ({
    game_id: "four-reversi",
    ruleset_version: options.extendedRules ? "four-reversi-singles-v2" : "four-reversi-singles-v1",
    state_version: options.extendedRules ? 2 : 1,
    agent_id: level === 1 ? "four-reversi-random-v1" : "four-reversi-greedy-v1",
    state: {
      board: state.board,
      ...(options.extendedRules ? { eliminatedColors: state.eliminatedColors } : {}),
      turn: state.turn,
      moveNumber: state.moveNumber,
      lastMove: state.lastMove,
      consecutivePasses: state.consecutivePasses,
    },
  }),
  readMove: (position) => ({ type: "placeStone", position: { ...position } }),
  fallbackAction: (state, seat) => {
    if (state.turn !== seat) return null;
    const position = getLegalMoves(state)[0];
    return position ? { type: "placeStone", position } : null;
  },
};
