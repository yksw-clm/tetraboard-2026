import { createGameProgress, type GameProgressSpec } from "@tetraboard/context-room";
import type { FourGomokuTypes } from "@tetraboard/four-gomoku/definition";
import {
  fourGomokuRoomSchema,
  fourGomokuStateSchema,
  type FourGomokuRoom,
} from "@tetraboard/protocol";
import { advanceClock, isClockExpired } from "../../clock";
import { migrateLegacyFourGomokuRoom } from "../../legacyRoomMigrations";
import { gameDefinitions } from "../gameDefinitions";
import type { ProgressDependencies } from "../gameProgress";
import { fourGomokuProgressStore, type FourGomokuStartArgs } from "./progressStore";

export { fourGomokuCpuJobKey, type FourGomokuCpuJob } from "./progressStore";

export class FourGomokuProgress {
  readonly start;
  readonly play;
  readonly resign;
  readonly prepareLeave;
  readonly leave;
  readonly eliminate;
  readonly cpu;
  readonly finalize;
  readonly waiting;

  constructor({ storage, membership, accountId }: ProgressDependencies) {
    const spec: GameProgressSpec<"four-gomoku", FourGomokuTypes, FourGomokuStartArgs> = {
      gameId: "four-gomoku",
      definition: gameDefinitions["four-gomoku"],
      parseRoom: (room) => fourGomokuRoomSchema.parse(room),
      parseFinishedState: (state) => {
        const game = fourGomokuStateSchema.parse(state);
        if (game.status !== "finished") throw new Error("Expected finished state");
        return game;
      },
      seat: (player) => player.color,
      inactiveSeats: (state) => [...state.eliminatedColors, ...state.completedColors],
      waitingSeat: { color: null },
      unknownPlayerMessage: "Unknown FourGomoku player",
      toAction: (command) => ({ type: "placeStone", position: command.action.position }),
      moveError: () => "invalid_move",
      prepareLeaveResult: ({ state }) => ({ ok: true, state }),
      advanceClock,
      isClockExpired,
      store: fourGomokuProgressStore(storage),
      membership,
      accountId,
      now: () => Date.now(),
      random: () => Math.random(),
    };
    const progress = createGameProgress(spec);
    this.start = progress.start.bind(progress);
    this.play = progress.play.bind(progress);
    this.resign = progress.resign.bind(progress);
    this.prepareLeave = progress.prepareLeave.bind(progress);
    this.leave = progress.leave.bind(progress);
    this.eliminate = progress.eliminate.bind(progress);
    this.cpu = progress.cpu.bind(progress);
    this.finalize = progress.finalize.bind(progress);
    this.waiting = progress.waiting.bind(progress);
  }

  migrateLegacy(room: FourGomokuRoom, readReplay: () => unknown): void {
    migrateLegacyFourGomokuRoom(room, readReplay);
  }
}
