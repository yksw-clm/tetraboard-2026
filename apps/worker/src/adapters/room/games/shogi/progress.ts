import { createGameProgress, type GameProgressSpec } from "@tetraboard/context-room";
import { shogiDefinition as definition, type ShogiTypes } from "@tetraboard/shogi/definition";
import {
  shogiRoomSchema,
  type ShogiRoom,
  type ShogiReplayEvent,
  type RoomSocketClientMessage,
} from "@tetraboard/protocol";
import {
  getActionAvailability,
  getCheckState,
  canProposeImpasse,
  type ShogiState,
} from "@tetraboard/shogi";
import { StandardShogiStore } from "./store";
import { advanceTurnClock } from "@tetraboard/context-room";
import { isClockExpired } from "../../clock";
import type { ProgressDependencies, ProgressFor, PlayingFor } from "../gameProgress";
import type { ShogiAiWork } from "../../ai/shogiAi";
import type { ShogiRatingSource } from "../../../rating/shogiRating";
import { shogiProgressStore } from "./progressStore";
import { StandardShogiCpu, shogiCpuJobKey, externalShogiCpuJobKey } from "./cpu";
export type { ShogiCpuJob } from "./cpu";
type Playing = PlayingFor<"shogi">;
type Result = ProgressFor<"shogi">;

export class ShogiProgress {
  private readonly storage: DurableObjectStorage;
  readonly start;
  readonly play;
  readonly resign;
  readonly eliminate;
  readonly isEliminated;
  readonly finalize;
  readonly waiting;
  private readonly command;
  private readonly acceptTransition;
  private shogiStore: StandardShogiStore | null = null;
  private readonly cpuProgress: StandardShogiCpu;

  constructor({ storage, membership, accountId }: ProgressDependencies) {
    this.storage = storage;
    this.cpuProgress = new StandardShogiCpu(storage, () => this.store());
    const spec: GameProgressSpec<"shogi", ShogiTypes, [rating?: ShogiRatingSource]> = {
      gameId: "shogi",
      definition,
      parseRoom: (room) => shogiRoomSchema.parse(room),
      parseFinishedState: (_state, saved) => {
        if (!saved || saved.status !== "finished") throw new Error("Expected finished Shogi state");
        return saved;
      },
      stateFromRoom: (game) => ({ ...game, repetitions: {} }),
      seat: (player) => player.side,
      inactiveSeats: (game) => game.eliminations.map((e) => e.side),
      waitingSeat: { side: null },
      unknownPlayerMessage: "Unknown Shogi player",
      useActionRules: true,
      toAction: (command) => command.action,
      moveError: (_reason, action) =>
        action.type === "drawProposal" || action.type === "declaration"
          ? "invalid_request"
          : "invalid_move",
      prepareLeaveResult: ({ state }) => ({ ok: true, state }),
      updatePlayersOnElimination: true,
      clearCpuJobsOnAccept: () => {
        storage.kv.delete(shogiCpuJobKey);
        storage.kv.delete(externalShogiCpuJobKey);
      },
      playingFields: (state) => ({
        eliminations: [...state.eliminations],
        ...getActionAvailability(state),
        checkState: getCheckState(state),
      }),
      waitingFields: { legalActions: [], checkState: { south: false, north: false } },
      advanceClock: (...args) => advanceTurnClock(...args),
      isClockExpired,
      store: shogiProgressStore(storage, () => this.store()),
      membership,
      accountId,
      now: () => Date.now(),
    };
    const progress = createGameProgress(spec);
    this.start = progress.start.bind(progress);
    this.play = progress.play.bind(progress);
    this.resign = progress.resign.bind(progress);
    this.eliminate = progress.eliminate.bind(progress);
    this.isEliminated = progress.isEliminated.bind(progress);
    this.finalize = progress.finalize.bind(progress);
    this.waiting = progress.waiting.bind(progress);
    this.command = progress.command.bind(progress);
    this.acceptTransition = progress.acceptTransition.bind(progress);
  }

  store(): StandardShogiStore {
    return (this.shogiStore ??= new StandardShogiStore(this.storage.sql));
  }

  draw(
    room: ShogiRoom,
    tokenHash: string,
    command: Extract<RoomSocketClientMessage, { type: "room.game.draw.set" }>,
  ): Result {
    return this.command(
      room,
      tokenHash,
      { type: "drawProposal", proposed: command.proposed },
      command,
    );
  }

  declare(
    room: ShogiRoom,
    tokenHash: string,
    command: Extract<RoomSocketClientMessage, { type: "room.game.declare" }>,
  ): Result {
    return this.command(room, tokenHash, { type: "declaration" }, command);
  }

  accept(
    room: Playing,
    state: ShogiState,
    event: ShogiReplayEvent,
    at: number,
    turnEnded: boolean,
  ): Result {
    return this.acceptTransition(room, { state, event }, at, turnEnded);
  }

  cpuDraw(room: Playing, now: number): Result {
    const cpu = room.players.find((p) => p.kind === "cpu");
    if (!cpu || !canProposeImpasse(room.game)) return { kind: "unchanged", gameId: "shogi", room };
    const humans = room.players.filter((p) => p.kind === "human" && !this.isEliminated(room, p.id));
    const proposed =
      humans.length > 0 && humans.every((p) => room.game.drawProposals.includes(p.side));
    if (room.game.drawProposals.includes(cpu.side) === proposed)
      return { kind: "unchanged", gameId: "shogi", room };
    const { state } = this.store().loadTransition(room.roundId, room.game);
    const result = definition.rules.applyAction(state, cpu.side, {
      type: "drawProposal",
      proposed,
    });
    if (!result.ok) throw new Error("Could not update CPU draw proposal");
    return this.accept(room, result.state, result.event, now, false);
  }

  externalCpuJob(room: Playing) {
    return this.cpuProgress.externalCpuJob(room);
  }
  prepareExternalCpu(room: Playing, now: number, timeout: number) {
    return this.cpuProgress.prepareExternalCpu(room, now, timeout);
  }
  completeExternalCpu(room: Playing, work: ShogiAiWork, move: string | null, now: number) {
    this.cpuProgress.completeExternalCpu(room, work, move, now);
  }
  cpu(room: Playing, now: number, externalMove: string | null = null): Result {
    const result = this.cpuProgress.cpu(room, now, externalMove);
    return result
      ? this.accept(room, result.state, result.event, now, true)
      : { kind: "unchanged", gameId: "shogi", room };
  }
}
