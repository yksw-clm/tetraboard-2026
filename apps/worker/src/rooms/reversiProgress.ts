import { checkGameCommand } from "@tetraboard/context-room";
import {
  reversiStateSchema,
  reversiRoomSchema,
  reversiReplaySchema as roundReplaySchema,
  type ReversiRoom,
  type ReversiLastRound as LastRound,
  type GameActionCommandFor,
} from "@tetraboard/protocol";
import type { ReversiState } from "@tetraboard/reversi";
import { advanceClock, isClockExpired } from "./reversiClock";
import { gameDefinitions } from "./gameDefinitions";
import {
  startReversiRound,
  recordReversiTransition,
  finalizeReversiRound,
  externalCpuJobKey,
} from "./reversiProgressStore";
import { ReversiExternalCpu } from "./reversiExternalCpu";
import { replayKey, nextPublicUpdateAt, cpuMoveDelayMs } from "./progressHelpers";
import type {
  ProgressDependencies,
  ProgressFor,
  PlayingFor,
  WaitingFor,
  FinishedProgress,
  RematchFor,
} from "./gameProgress";
import type { ReversiAiWork } from "./aiService";
import type { EloRatingSource } from "./eloRating";
type Playing = PlayingFor<"reversi">;
type Result = ProgressFor<"reversi">;
const definition = gameDefinitions.reversi;
export class ReversiProgress {
  private readonly storage: DurableObjectStorage;
  private readonly membership: ProgressDependencies["membership"];
  private readonly accountId: ProgressDependencies["accountId"];
  private readonly external: ReversiExternalCpu;
  constructor(dependencies: ProgressDependencies) {
    this.storage = dependencies.storage;
    this.external = new ReversiExternalCpu(this.storage);
    this.membership = dependencies.membership;
    this.accountId = dependencies.accountId;
  }

  start(
    room: WaitingFor<"reversi">,
    rating?: EloRatingSource,
  ): { room: Playing; roundId: string; at: number } {
    return startReversiRound(this.storage, room, this.accountId, rating);
  }

  play(room: ReversiRoom, tokenHash: string, command: GameActionCommandFor<"reversi">): Result {
    const error = this.checkCommand(
      room,
      tokenHash,
      "play",
      room.roundId === command.roundId && room.positionRevision === command.positionRevision,
    );
    if (error) return { kind: "rejected", error };
    if (room.status !== "playing") throw new Error("Expected playing room");
    const result = definition.rules.applyAction(room.game, room.game.turn, command.action);
    if (!result.ok) return { kind: "rejected", error: "invalid_move" };
    recordReversiTransition(this.storage, room, result);
    return this.accept(room, result.state, Date.now(), true);
  }

  resign(room: ReversiRoom, tokenHash: string): Result {
    const error = this.checkCommand(room, tokenHash, "resign", true);
    if (error) return { kind: "rejected", error };
    if (room.status !== "playing") throw new Error("Expected playing room");
    const result = definition.rules.eliminateSeat(room.game, room.game.turn, "resigned");
    recordReversiTransition(this.storage, room, result);
    return this.accept(room, result.state, Date.now(), true);
  }

  private checkCommand(
    room: ReversiRoom,
    tokenHash: string,
    operation: "play" | "resign",
    positionMatches: boolean,
  ) {
    const membership = this.membership(tokenHash);
    const seat = room.players.find((p) => p.id === membership?.playerId)?.color ?? null;
    return checkGameCommand({
      operation,
      status: room.status,
      hasLastRound: room.lastRound !== null,
      seat,
      eliminatedSeats: room.game?.eliminatedColors ?? [],
      turn: room.game === null ? null : definition.rules.getTurn(room.game),
      positionMatches,
      clockExpired: room.clock !== null && isClockExpired(room.clock, Date.now()),
    });
  }

  private accept(
    room: Playing,
    state: ReversiState,
    at: number,
    turnEnded: boolean,
    clockAt = at,
  ): Result {
    if (state.status === "finished") {
      const game = reversiStateSchema.parse(state);
      if (game.status !== "finished") throw new Error("Expected finished state");
      return {
        kind: "finished",
        gameId: "reversi",
        room: { ...room, positionRevision: room.positionRevision + 1 },
        game,
        at,
      };
    }
    const updated = reversiRoomSchema.parse({
      ...room,
      game: state,
      positionRevision: room.positionRevision + 1,
      clock: advanceClock(
        room.clock,
        room.game.turn,
        state.turn,
        clockAt,
        turnEnded,
        room.settings.timeControl,
      ),
      lastActivityAtMs: at,
    });
    if (updated.status !== "playing") throw new Error("Expected playing room");
    return { kind: "playing", gameId: "reversi", room: updated };
  }

  prepareLeave(room: Playing, playerId: string) {
    const player = room.players.find((p) => p.id === playerId);
    if (!player) throw new Error("Unknown Reversi player");
    if (room.game.eliminatedColors.includes(player.color)) return null;
    const result = definition.rules.eliminateSeat(room.game, player.color, "left");
    recordReversiTransition(this.storage, room, result);
    return { ok: true as const, state: result.state, passedColors: result.event.passedColors };
  }

  leave(
    room: Playing,
    playerId: string,
    prepared: ReturnType<ReversiProgress["prepareLeave"]>,
    at: number,
    hostLeaving: boolean,
  ): Result {
    if (prepared?.state.status === "finished") return this.accept(room, prepared.state, at, true);
    const input = reversiRoomSchema.parse({
      ...room,
      publicUpdatedAtMs: hostLeaving ? nextPublicUpdateAt(room) : room.publicUpdatedAtMs,
      players: room.players.map((p) => ({
        ...p,
        reconnectDeadline: p.id === playerId ? null : p.reconnectDeadline,
      })),
    });
    if (input.status !== "playing") throw new Error("Expected playing room");
    return this.accept(
      input,
      prepared?.state ?? room.game,
      at,
      !!prepared && prepared.state.turn !== room.game.turn,
    );
  }

  eliminate(
    room: Playing,
    playerId: string,
    reason: "timeout" | "disconnected",
    at: number,
  ): Result {
    const player = room.players.find((p) => p.id === playerId);
    if (!player) throw new Error("Unknown Reversi player");
    if (reason === "disconnected" && room.game.eliminatedColors.includes(player.color))
      return {
        kind: "unchanged",
        gameId: "reversi",
        room: reversiRoomSchema.parse({
          ...room,
          players: room.players.map((p) =>
            p.id === playerId ? { ...p, reconnectDeadline: null } : p,
          ),
        }),
      };
    const result = definition.rules.eliminateSeat(room.game, player.color, reason);
    recordReversiTransition(this.storage, room, result);
    if (result.state.status === "finished") return this.accept(room, result.state, at, true);
    const input = reversiRoomSchema.parse({
      ...room,
      players: room.players.map((p) =>
        p.id === playerId && reason === "disconnected" ? { ...p, reconnectDeadline: null } : p,
      ),
    });
    if (input.status !== "playing") throw new Error("Expected playing room");
    return this.accept(
      input,
      result.state,
      at,
      reason === "timeout" || result.state.turn !== room.game.turn,
    );
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
    return this.accept(
      room,
      result.state,
      decidedAt,
      true,
      expired ? room.clock.turnExpiresAt : decidedAt,
    );
  }

  finalize(result: FinishedProgress<"reversi">): LastRound {
    return finalizeReversiRound(this.storage, result.room, result.game, result.at);
  }

  waiting(data: RematchFor<"reversi">, players: ReversiRoom["players"]): WaitingFor<"reversi"> {
    const room = reversiRoomSchema.parse({
      ...data.room,
      status: "waiting",
      roundId: null,
      positionRevision: 0,
      eliminations: [],
      publicUpdatedAtMs: nextPublicUpdateAt(data.room),
      lastActivityAtMs: data.at,
      players: players.map((p) => ({ ...p, color: null })),
      game: null,
      clock: null,
      lastRound: data.lastRound,
    });
    if (room.status !== "waiting") throw new Error("Expected waiting room");
    return room;
  }

  normalize(room: ReversiRoom, saved: object): void {
    if (room.status !== "playing" || Object.hasOwn(saved, "eliminations")) return;
    const replay = this.storage.kv.get(replayKey);
    if (replay === undefined) return;
    for (const { action } of roundReplaySchema.parse(replay).steps)
      if (
        action.type === "eliminate" &&
        room.game.eliminatedColors.includes(action.color) &&
        !room.eliminations.some((e) => e.color === action.color)
      )
        room.eliminations.push({ color: action.color, reason: action.reason });
  }
}
