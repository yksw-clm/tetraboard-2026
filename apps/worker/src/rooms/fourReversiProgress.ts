import { migrateLegacyFourReversiRoom } from "./legacyRoomMigrations";
import { checkGameCommand } from "@tetraboard/context-room";
import { gameDefinitions } from "./gameDefinitions";
import {
  fourReversiStateSchema,
  fourReversiRoomSchema,
  type FourReversiRoom,
  type LastRound,
  type GameActionCommandFor,
} from "@tetraboard/protocol";
import type { Position, FourReversiState } from "@tetraboard/four-reversi";
import { advanceClock, isClockExpired } from "./clock";
import { nextPublicUpdateAt } from "./progressHelpers";
import type {
  ProgressDependencies,
  ProgressFor,
  PlayingFor,
  WaitingFor,
  FinishedProgress,
  RematchFor,
} from "./gameProgress";
import type { TournamentRoomContext } from "./tournamentRoom";
import type { FourReversiRatingSource } from "../matchmaking/fourReversiSelection";
import type { ServiceProfile } from "./aiServiceProfiles";
import {
  startFourReversiRound,
  recordFourReversiTransition,
  finalizeFourReversiRound,
} from "./fourReversiProgressStore";
import {
  FourReversiCpu,
  fourReversiCpuJobKey,
  fourReversiAiJobKey,
  type ExternalCpuWork,
} from "./fourReversiCpu";
export {
  fourReversiCpuJobKey,
  fourReversiAiJobKey,
  supportsExternalAi,
  type FourReversiCpuJob,
  type ExternalCpuWork,
} from "./fourReversiCpu";
type Playing = PlayingFor<"four-reversi">;
type Result = ProgressFor<"four-reversi">;
const definition = gameDefinitions["four-reversi"];

export class FourReversiProgress {
  private readonly storage: DurableObjectStorage;
  private readonly membership: ProgressDependencies["membership"];
  private readonly accountId: ProgressDependencies["accountId"];
  private readonly cpuProgress: FourReversiCpu;
  constructor(dependencies: ProgressDependencies) {
    this.storage = dependencies.storage;
    this.cpuProgress = new FourReversiCpu(dependencies.storage);
    this.membership = dependencies.membership;
    this.accountId = dependencies.accountId;
  }

  start(
    room: WaitingFor<"four-reversi">,
    tournament?: TournamentRoomContext,
    rating?: FourReversiRatingSource,
  ) {
    return startFourReversiRound(this.storage, room, this.accountId, tournament, rating);
  }

  play(
    room: FourReversiRoom,
    tokenHash: string,
    command: GameActionCommandFor<"four-reversi">,
  ): Result {
    const error = this.checkCommand(room, tokenHash, "play");
    if (error) return { kind: "rejected", error };
    if (room.status !== "playing") throw new Error("Expected playing room");
    const result = definition.rules.applyAction(room.game, room.game.turn, command.action);
    if (!result.ok) return { kind: "rejected", error: "invalid_move" };
    recordFourReversiTransition(this.storage, room, result);
    return this.accept(room, result.state, Date.now(), true);
  }

  resign(room: FourReversiRoom, tokenHash: string): Result {
    const error = this.checkCommand(room, tokenHash, "resign");
    if (error) return { kind: "rejected", error };
    if (room.status !== "playing") throw new Error("Expected playing room");
    const result = definition.rules.eliminateSeat(room.game, room.game.turn, "resigned");
    recordFourReversiTransition(this.storage, room, result);
    return this.accept(room, result.state, Date.now(), true);
  }

  private checkCommand(room: FourReversiRoom, tokenHash: string, operation: "play" | "resign") {
    const membership = this.membership(tokenHash);
    const seat = room.players.find((p) => p.id === membership?.playerId)?.color ?? null;
    return checkGameCommand({
      operation,
      status: room.status,
      hasLastRound: room.lastRound !== null,
      seat,
      eliminatedSeats: room.game?.eliminatedColors ?? [],
      turn: room.game === null ? null : definition.rules.getTurn(room.game),
      positionMatches: true,
      clockExpired: room.clock !== null && isClockExpired(room.clock, Date.now()),
    });
  }

  private accept(
    room: Playing,
    state: FourReversiState,
    at: number,
    turnEnded: boolean,
    clockAt = at,
  ): Result {
    this.storage.kv.delete(fourReversiCpuJobKey);
    this.storage.kv.delete(fourReversiAiJobKey);
    if (state.status === "finished") {
      const game = fourReversiStateSchema.parse(state);
      if (game.status !== "finished") throw new Error("Expected finished state");
      return { kind: "finished", gameId: "four-reversi", room, game, at };
    }
    const updated = fourReversiRoomSchema.parse({
      ...room,
      game: state,
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
    return { kind: "playing", gameId: "four-reversi", room: updated };
  }

  prepareLeave(room: Playing, playerId: string) {
    const player = room.players.find((p) => p.id === playerId);
    if (!player) throw new Error("Unknown Reversi player");
    if (room.game.eliminatedColors.includes(player.color)) return null;
    const result = definition.rules.eliminateSeat(room.game, player.color, "left");
    recordFourReversiTransition(this.storage, room, result);
    return { ok: true as const, state: result.state, passedColors: result.event.passedColors };
  }

  leave(
    room: Playing,
    playerId: string,
    prepared: ReturnType<FourReversiProgress["prepareLeave"]>,
    at: number,
    hostLeaving: boolean,
  ): Result {
    if (prepared?.state.status === "finished") return this.accept(room, prepared.state, at, true);
    const input = fourReversiRoomSchema.parse({
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
        gameId: "four-reversi",
        room: fourReversiRoomSchema.parse({
          ...room,
          players: room.players.map((p) =>
            p.id === playerId ? { ...p, reconnectDeadline: null } : p,
          ),
        }),
      };
    const result = definition.rules.eliminateSeat(room.game, player.color, reason);
    recordFourReversiTransition(this.storage, room, result);
    if (result.state.status === "finished") return this.accept(room, result.state, at, true);
    const input = fourReversiRoomSchema.parse({
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

  finalize(result: FinishedProgress<"four-reversi">): LastRound {
    return finalizeFourReversiRound(this.storage, result.room, result.game, result.at);
  }

  waiting(
    data: RematchFor<"four-reversi">,
    players: FourReversiRoom["players"],
  ): WaitingFor<"four-reversi"> {
    this.storage.kv.delete(fourReversiCpuJobKey);
    this.storage.kv.delete(fourReversiAiJobKey);
    const room = fourReversiRoomSchema.parse({
      ...data.room,
      status: "waiting",
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

  migrateLegacy(room: FourReversiRoom, saved: object, readReplay: () => unknown): void {
    migrateLegacyFourReversiRoom(room, saved, readReplay);
  }
}
