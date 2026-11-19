import { createGameProgress, type GameProgressSpec } from "@tetraboard/context-room";
import type { GomokuTypes } from "@tetraboard/gomoku/definition";
import { gomokuRoomSchema, gomokuStateSchema } from "@tetraboard/protocol";
import { advanceClock, isClockExpired } from "../../reversiClock";
import { gameDefinitions } from "../gameDefinitions";
import type { ProgressDependencies } from "../gameProgress";
import { gomokuMoveError } from "./progressErrors";
import { gomokuProgressStore } from "./progressStore";

export { gomokuCpuJobKey, type GomokuCpuJob } from "./progressStore";

export function createGomokuProgress({ storage, membership, accountId }: ProgressDependencies) {
  const spec: GameProgressSpec<"gomoku", GomokuTypes> = {
    gameId: "gomoku",
    definition: gameDefinitions.gomoku,
    parseRoom: (room) => gomokuRoomSchema.parse(room),
    parseFinishedState: (state) => {
      const game = gomokuStateSchema.parse(state);
      if (game.status !== "finished") throw new Error("Expected finished state");
      return game;
    },
    seat: (player) => player.color,
    inactiveSeats: (state) => state.eliminatedColors,
    waitingSeat: { color: null },
    unknownPlayerMessage: "Unknown Gomoku player",
    toAction: (command) => ({ type: "placeStone", position: command.action.position }),
    moveError: gomokuMoveError,
    advanceClock,
    isClockExpired,
    store: gomokuProgressStore(storage),
    membership,
    accountId,
    now: () => Date.now(),
    random: () => Math.random(),
  };
  return createGameProgress(spec);
}
