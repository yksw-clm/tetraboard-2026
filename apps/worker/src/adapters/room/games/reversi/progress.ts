import { createGameProgress, type GameProgressSpec } from "@tetraboard/context-room";
import { reversiStateSchema, reversiRoomSchema } from "@tetraboard/protocol";
import type { ReversiTypes } from "@tetraboard/reversi/definition";
import { advanceClock, isClockExpired } from "../../reversiClock";
import { gameDefinitions } from "../gameDefinitions";
import {
  externalCpuJobKey,
  recordReversiTransition,
  reversiProgressStore,
  type ReversiStartArgs,
} from "./progressStore";
import { ReversiExternalCpu } from "../../ai/reversiExternalCpu";
import { cpuMoveDelayMs } from "../progressHelpers";
import type { ProgressDependencies, ProgressFor, PlayingFor } from "../gameProgress";
import type { ReversiAiWork } from "../../ai/reversiAi";

type Playing = PlayingFor<"reversi">;
type Result = ProgressFor<"reversi">;
const definition = gameDefinitions.reversi;

export class ReversiProgress {
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
  private readonly external: ReversiExternalCpu;

  constructor({ storage, membership, accountId }: ProgressDependencies) {
    this.storage = storage;
    this.external = new ReversiExternalCpu(storage);
    const spec = {
      gameId: "reversi",
      definition,
      parseRoom: (room) => reversiRoomSchema.parse(room),
      parseFinishedState: (state) => {
        const game = reversiStateSchema.parse(state);
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
      incrementRevisionOnFinish: true,
      advanceClock,
      isClockExpired,
      store: reversiProgressStore(storage),
      membership,
      accountId,
      now: () => Date.now(),
    } satisfies GameProgressSpec<"reversi", ReversiTypes, ReversiStartArgs>;
    const progress = createGameProgress(spec);
    this.start = progress.start.bind(progress);
    this.play = progress.play.bind(progress);
    this.resign = progress.resign.bind(progress);
    this.prepareLeave = progress.prepareLeave.bind(progress);
    this.leave = progress.leave.bind(progress);
    this.eliminate = progress.eliminate.bind(progress);
    this.finalize = progress.finalize.bind(progress);
    this.waiting = progress.waiting.bind(progress);
    this.accept = progress.accept.bind(progress);
  }

  externalCpuJob(room: Playing) {
    return this.external.externalCpuJob(room);
  }

  prepareExternalCpu(room: Playing, now: number, timeout: number): ReversiAiWork | null {
    return this.external.prepareExternalCpu(room, now, timeout);
  }

  completeExternalCpu(
    room: Playing,
    work: ReversiAiWork,
    move: import("@tetraboard/reversi").Position | null,
    now: number,
  ) {
    return this.external.completeExternalCpu(room, work, move, now);
  }

  cpu(room: Playing, now: number): Result {
    if (room.clock.turnStartedAt + cpuMoveDelayMs > now || isClockExpired(room.clock, now))
      return { kind: "unchanged", gameId: "reversi", room };
    const cpu = room.players.find((p) => p.color === room.game.turn);
    if (cpu?.kind !== "cpu") return { kind: "unchanged", gameId: "reversi", room };
    const job = this.externalCpuJob(room);
    const action = job?.position
      ? { type: "placeStone" as const, position: job.position }
      : definition.cpu.chooseAction(room.game, cpu.color, cpu.level, Math.random);
    if (action === null) throw new Error("CPU has no legal move");
    const decidedAt = Date.now();
    const expired = isClockExpired(room.clock, decidedAt);
    const result = expired
      ? {
          ok: true as const,
          ...definition.rules.eliminateSeat(room.game, room.game.turn, "timeout"),
        }
      : definition.rules.applyAction(room.game, room.game.turn, action);
    if (!result.ok) throw new Error("CPU selected an invalid move");
    if (!expired) this.external.recordFallback(job);
    recordReversiTransition(this.storage, room, result);
    if (job) this.storage.kv.delete(externalCpuJobKey);
    return this.accept(room, result.state, decidedAt, true, {
      clockAt: expired ? room.clock.turnExpiresAt : decidedAt,
    });
  }
}
