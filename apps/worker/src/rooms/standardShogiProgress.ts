import { checkGameCommand } from "@tetraboard/context-room";
import { shogiDefinition as definition, type ShogiGameAction } from "@tetraboard/shogi/definition";
import {
  shogiRoomSchema,
  type ShogiRoom,
  type ShogiReplayEvent,
  type RoomSocketClientMessage,
  type GameActionCommandFor,
} from "@tetraboard/protocol";
import {
  getActionAvailability,
  getCheckState,
  canProposeImpasse,
  type ShogiState,
  type ExternalEliminationReason,
} from "@tetraboard/shogi";
import { StandardShogiStore } from "./standardShogiStore";
import { advanceTurnClock } from "./clockCore";
import { isClockExpired } from "./clock";
import { nextPublicUpdateAt } from "./progressHelpers";
import type {
  ProgressDependencies,
  ProgressFor,
  PlayingFor,
  WaitingFor,
  FinishedProgress,
  RematchFor,
} from "./gameProgress";
import type { ShogiAiWork } from "../adapters/room/ai/shogiAi";
import type { ShogiRatingSource } from "../adapters/rating/shogiRating";
import { startShogiRound, finalizeShogiRound } from "./standardShogiProgressStore";
import { StandardShogiCpu, shogiCpuJobKey, externalShogiCpuJobKey } from "./standardShogiCpu";
export type { ShogiCpuJob } from "./standardShogiCpu";
type Playing = PlayingFor<"shogi">;
type Result = ProgressFor<"shogi">;

export class ShogiProgress {
  private readonly storage: DurableObjectStorage;
  private readonly membership: ProgressDependencies["membership"];
  private readonly accountId: ProgressDependencies["accountId"];
  private shogiStore: StandardShogiStore | null = null;
  private readonly cpuProgress: StandardShogiCpu;
  constructor(dependencies: ProgressDependencies) {
    this.storage = dependencies.storage;
    this.cpuProgress = new StandardShogiCpu(dependencies.storage, () => this.store());
    this.membership = dependencies.membership;
    this.accountId = dependencies.accountId;
  }

  store(): StandardShogiStore {
    return (this.shogiStore ??= new StandardShogiStore(this.storage.sql));
  }

  isEliminated(room: ShogiRoom, playerId: string): boolean {
    if (room.status !== "playing") return false;
    const player = room.players.find((p) => p.id === playerId);
    return !!player && room.game.eliminations.some((e) => e.side === player.side);
  }

  play(room: ShogiRoom, tokenHash: string, command: GameActionCommandFor<"shogi">): Result {
    return this.command(room, tokenHash, command.action, command);
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

  private checkCommand(
    room: ShogiRoom,
    tokenHash: string,
    operation: "play" | "resign",
    command?: { roundId: string; positionRevision: number },
    action?: ShogiGameAction,
  ) {
    const membership = this.membership(tokenHash);
    const player = room.players.find((p) => p.id === membership?.playerId);
    const error = checkGameCommand({
      operation,
      status: room.status,
      hasLastRound: room.lastRound !== null,
      seat: player?.side ?? null,
      eliminatedSeats: room.game?.eliminations.map((e) => e.side) ?? [],
      turn: room.game
        ? definition.rules.getTurn({ ...room.game, repetitions: {} } as ShogiState)
        : null,
      positionMatches:
        room.status === "playing" &&
        command?.roundId === room.roundId &&
        command?.positionRevision === room.positionRevision,
      clockExpired: room.clock !== null && isClockExpired(room.clock, Date.now()),
      requiresTurn: action ? (definition.rules.requiresTurn?.(action) ?? true) : true,
    });
    return { error, player };
  }

  private command(
    room: ShogiRoom,
    tokenHash: string,
    action: ShogiGameAction,
    command: { roundId: string; positionRevision: number },
  ): Result {
    const { error, player } = this.checkCommand(room, tokenHash, "play", command, action);
    if (error) return { kind: "rejected", error };
    if (room.status !== "playing" || !player?.side) throw new Error("Expected playing seat");
    const { state, repetitionLookup } = this.store().loadTransition(room.roundId, room.game);
    const result = definition.rules.applyAction(state, player.side, action, repetitionLookup);
    if (!result.ok)
      return {
        kind: "rejected",
        error:
          action.type === "drawProposal" || action.type === "declaration"
            ? "invalid_request"
            : "invalid_move",
      };
    if (result.state === state) return { kind: "unchanged", gameId: "shogi", room };
    return this.accept(
      room,
      result.state,
      result.event,
      Date.now(),
      definition.rules.endsTurn?.(action) ?? true,
    );
  }

  resign(room: ShogiRoom, tokenHash: string): Result {
    const { error, player } = this.checkCommand(room, tokenHash, "resign");
    if (error) return { kind: "rejected", error };
    if (room.status !== "playing" || !player) throw new Error("Expected playing seat");
    return this.eliminate(room, player.id, "resigned", Date.now());
  }

  start(room: WaitingFor<"shogi">, rating?: ShogiRatingSource) {
    return startShogiRound(this.storage, this.store(), this.accountId, room, rating);
  }

  finalize(result: FinishedProgress<"shogi">) {
    return finalizeShogiRound(this.storage, this.store(), result);
  }

  accept(
    room: Extract<ShogiRoom, { status: "playing" }>,
    state: ShogiState,
    event: ShogiReplayEvent,
    at: number,
    turnEnded: boolean,
  ): Result {
    this.store().appendEvent(room.roundId, event);
    const core = this.store().saveState(room.roundId, state);
    this.storage.kv.delete(shogiCpuJobKey);
    this.storage.kv.delete(externalShogiCpuJobKey);
    if (state.status === "finished") {
      if (core.status !== "finished") throw new Error("Expected finished Shogi state");
      return { kind: "finished", gameId: "shogi", room, game: core, at };
    }
    const updated = shogiRoomSchema.parse({
      ...room,
      game: core,
      eliminations: state.eliminations,
      positionRevision: room.positionRevision + 1,
      ...getActionAvailability(state),
      checkState: getCheckState(state),
      clock: advanceTurnClock(
        room.clock,
        room.game.turn,
        state.turn,
        at,
        turnEnded,
        room.settings.timeControl,
      ),
      lastActivityAtMs: at,
    });
    if (updated.status !== "playing") throw new Error("Expected playing room");
    return { kind: "playing", gameId: "shogi", room: updated };
  }

  eliminate(
    room: Extract<ShogiRoom, { status: "playing" }>,
    playerId: string,
    reason: ExternalEliminationReason,
    at: number,
  ): Result {
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player) throw new Error("Unknown Shogi player");
    const clearDeadline = reason === "left" || reason === "disconnected";
    const players = room.players.map((entry) => ({
      ...entry,
      reconnectDeadline: entry.id === playerId && clearDeadline ? null : entry.reconnectDeadline,
    }));
    if (this.isEliminated(room, playerId))
      return {
        kind: "unchanged",
        gameId: "shogi",
        room: shogiRoomSchema.parse({ ...room, players }),
      };
    const { state } = this.store().loadTransition(room.roundId, room.game);
    const result = definition.rules.eliminateSeat(state, player.side, reason);
    const input = shogiRoomSchema.parse({ ...room, players });
    if (input.status !== "playing") throw new Error("Expected playing room");
    return this.accept(input, result.state, result.event, at, result.state.turn !== room.game.turn);
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

  waiting(data: RematchFor<"shogi">, players: ShogiRoom["players"]): WaitingFor<"shogi"> {
    const room = shogiRoomSchema.parse({
      ...data.room,
      status: "waiting",
      eliminations: [],
      publicUpdatedAtMs: nextPublicUpdateAt(data.room),
      lastActivityAtMs: data.at,
      players: players.map((p) => ({ ...p, side: null })),
      game: null,
      clock: null,
      lastRound: data.lastRound,
      roundId: null,
      positionRevision: 0,
      legalActions: [],
      checkState: { south: false, north: false },
    });
    if (room.status !== "waiting") throw new Error("Expected waiting room");
    return room;
  }
}
