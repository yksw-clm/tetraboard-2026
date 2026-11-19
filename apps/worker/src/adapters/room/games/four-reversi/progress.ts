import { createGameProgress, type GameProgressSpec } from "@tetraboard/context-room";
import type { Position } from "@tetraboard/four-reversi";
import type { FourReversiTypes } from "@tetraboard/four-reversi/definition";
import {
  fourReversiStateSchema,
  fourReversiRoomSchema,
  type FourReversiRoom,
} from "@tetraboard/protocol";
import { migrateLegacyFourReversiRoom } from "../../legacyRoomMigrations";
import { advanceClock, isClockExpired } from "../../clock";
import type { ServiceProfile } from "../../ai/aiServiceProfiles";
import { gameDefinitions } from "../gameDefinitions";
import type { ProgressDependencies, ProgressFor, PlayingFor, RematchFor } from "../gameProgress";
import {
  clearFourReversiCpuJobs,
  fourReversiProgressStore,
  recordFourReversiTransition,
  type FourReversiStartArgs,
} from "./progressStore";
import { FourReversiCpu, type ExternalCpuWork } from "./cpu";

export {
  fourReversiCpuJobKey,
  fourReversiAiJobKey,
  supportsExternalAi,
  type FourReversiCpuJob,
  type ExternalCpuWork,
} from "./cpu";

type Playing = PlayingFor<"four-reversi">;
type Result = ProgressFor<"four-reversi">;

export class FourReversiProgress {
  readonly start;
  readonly play;
  readonly resign;
  readonly prepareLeave;
  readonly leave;
  readonly eliminate;
  readonly finalize;
  readonly waiting;
  private readonly accept;
  private readonly storage: DurableObjectStorage;
  private readonly cpuProgress: FourReversiCpu;

  constructor({ storage, membership, accountId }: ProgressDependencies) {
    this.storage = storage;
    this.cpuProgress = new FourReversiCpu(storage);
    const spec = {
      gameId: "four-reversi",
      definition: gameDefinitions["four-reversi"],
      parseRoom: (room) => fourReversiRoomSchema.parse(room),
      parseFinishedState: (state) => {
        const game = fourReversiStateSchema.parse(state);
        if (game.status !== "finished") throw new Error("Expected finished state");
        return game;
      },
      seat: (player) => player.color,
      inactiveSeats: (state) => state.eliminatedColors,
      waitingSeat: { color: null },
      unknownPlayerMessage: "Unknown Reversi player",
      toAction: (command) => command.action,
      moveError: () => "invalid_move",
      prepareLeaveResult: ({ state, event }) => ({
        ok: true,
        state,
        passedColors: event.passedColors,
      }),
      preservePositionOnInactiveLeave: true,
      incrementRevisionOnFinish: true,
      clearCpuJobsOnAccept: () => clearFourReversiCpuJobs(storage),
      advanceClock,
      isClockExpired,
      store: fourReversiProgressStore(storage),
      membership,
      accountId,
      now: () => Date.now(),
    } satisfies GameProgressSpec<"four-reversi", FourReversiTypes, FourReversiStartArgs>;
    const progress = createGameProgress(spec);
    this.start = progress.start.bind(progress);
    this.play = progress.play.bind(progress);
    this.resign = progress.resign.bind(progress);
    this.prepareLeave = progress.prepareLeave.bind(progress);
    this.leave = progress.leave.bind(progress);
    this.eliminate = progress.eliminate.bind(progress);
    this.finalize = progress.finalize.bind(progress);
    this.waiting = (data: RematchFor<"four-reversi">, players: FourReversiRoom["players"]) => {
      clearFourReversiCpuJobs(storage);
      return progress.waiting(data, players);
    };
    this.accept = progress.accept.bind(progress);
  }

  cpuJob(room: Playing) {
    return this.cpuProgress.cpuJob(room);
  }

  cpu(room: Playing, now: number): Result {
    const result = this.cpuProgress.cpu(room, now);
    if (!result) return { kind: "unchanged", gameId: "four-reversi", room };
    recordFourReversiTransition(this.storage, room, result);
    return this.accept(room, result.state, now, true);
  }

  externalCpuJob(room: Playing) {
    return this.cpuProgress.externalCpuJob(room);
  }

  prepareExternalCpu(
    room: Playing,
    now: number,
    timeoutMs: number,
    serviceProfile?: ServiceProfile,
  ) {
    return this.cpuProgress.prepareExternalCpu(room, now, timeoutMs, serviceProfile);
  }

  completeExternalCpu(
    room: Playing,
    job: ExternalCpuWork["job"],
    position: Position | null,
    now: number,
  ): boolean {
    return this.cpuProgress.completeExternalCpu(room, job, position, now);
  }

  migrateLegacy(room: FourReversiRoom, saved: object, readReplay: () => unknown): void {
    migrateLegacyFourReversiRoom(room, saved, readReplay);
  }
}
