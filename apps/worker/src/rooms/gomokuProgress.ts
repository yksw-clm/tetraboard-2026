import { checkGameCommand } from "@tetraboard/context-room";
import {
  gomokuStateSchema,
  gomokuRoomSchema,
  type GomokuRoom,
  type GomokuLastRound as LastRound,
  type GameActionCommandFor,
} from "@tetraboard/protocol";
import type { ApplyActionResult, GomokuState, Color, Position } from "@tetraboard/gomoku";
import { advanceClock, isClockExpired } from "../adapters/room/reversiClock";
import { gameDefinitions } from "./gameDefinitions";
import { gomokuMoveError } from "./gomokuProgressErrors";
import {
  startGomokuRound,
  recordGomokuTransition,
  finalizeGomokuRound,
} from "./gomokuProgressStore";
import { nextPublicUpdateAt, cpuMoveDelayMs } from "./progressHelpers";
import type {
  ProgressDependencies,
  ProgressFor,
  PlayingFor,
  WaitingFor,
  FinishedProgress,
  RematchFor,
} from "./gameProgress";
type Playing = PlayingFor<"gomoku">;
type Result = ProgressFor<"gomoku">;
const definition = gameDefinitions.gomoku;
export const gomokuCpuJobKey = "gomoku-cpu-job";
export type GomokuCpuJob = {
  roundId: string;
  positionRevision: number;
  color: Color;
  move: Position;
  applyAt: number;
};
export class GomokuProgress {
  private readonly storage: DurableObjectStorage;
  private readonly membership: ProgressDependencies["membership"];
  private readonly accountId: ProgressDependencies["accountId"];
  constructor(dependencies: ProgressDependencies) {
    this.storage = dependencies.storage;
    this.membership = dependencies.membership;
    this.accountId = dependencies.accountId;
  }

  start(room: WaitingFor<"gomoku">): { room: Playing; roundId: string; at: number } {
    this.storage.kv.delete(gomokuCpuJobKey);
    return startGomokuRound(this.storage, room, this.accountId);
  }

  play(room: GomokuRoom, tokenHash: string, command: GameActionCommandFor<"gomoku">): Result {
    const error = this.checkCommand(
      room,
      tokenHash,
      "play",
      room.roundId === command.roundId && room.positionRevision === command.positionRevision,
    );
    if (error) return { kind: "rejected", error };
    if (room.status !== "playing") throw new Error("Expected playing room");
    const result = definition.rules.applyAction(room.game, room.game.turn, {
      type: "placeStone",
      position: command.action.position,
    });
    if (!result.ok) return { kind: "rejected", error: gomokuMoveError(result.reason) };
    recordGomokuTransition(this.storage, room, result);
    return this.accept(room, result.state, Date.now(), true);
  }

  resign(room: GomokuRoom, tokenHash: string): Result {
    const error = this.checkCommand(room, tokenHash, "resign", true);
    if (error) return { kind: "rejected", error };
    if (room.status !== "playing") throw new Error("Expected playing room");
    const result = definition.rules.eliminateSeat(room.game, room.game.turn, "resigned");
    recordGomokuTransition(this.storage, room, result);
    return this.accept(room, result.state, Date.now(), true);
  }

  private checkCommand(
    room: GomokuRoom,
    tokenHash: string,
    operation: "play" | "resign",
    positionMatches: boolean,
  ) {
    const membership = this.membership(tokenHash);
    const seat = room.players.find((player) => player.id === membership?.playerId)?.color ?? null;
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
    state: GomokuState,
    at: number,
    turnEnded: boolean,
    clockAt = at,
  ): Result {
    this.storage.kv.delete(gomokuCpuJobKey);
    if (state.status === "finished") {
      const game = gomokuStateSchema.parse(state);
      if (game.status !== "finished") throw new Error("Expected finished state");
      return { kind: "finished", gameId: "gomoku", room, game, at };
    }
    const updated = gomokuRoomSchema.parse({
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
    return { kind: "playing", gameId: "gomoku", room: updated };
  }

  prepareLeave(room: Playing, playerId: string): Extract<ApplyActionResult, { ok: true }> | null {
    const player = room.players.find((p) => p.id === playerId);
    if (!player) throw new Error("Unknown Gomoku player");
    if (room.game.eliminatedColors.includes(player.color)) return null;
    const result = definition.rules.eliminateSeat(room.game, player.color, "left");
    recordGomokuTransition(this.storage, room, result);
    return { ok: true, state: result.state };
  }

  leave(
    room: Playing,
    playerId: string,
    prepared: ReturnType<GomokuProgress["prepareLeave"]>,
    at: number,
    hostLeaving: boolean,
  ): Result {
    if (prepared?.state.status === "finished") return this.accept(room, prepared.state, at, true);
    const input = gomokuRoomSchema.parse({
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
    if (!player) throw new Error("Unknown Gomoku player");
    if (reason === "disconnected" && room.game.eliminatedColors.includes(player.color))
      return {
        kind: "unchanged",
        gameId: "gomoku",
        room: gomokuRoomSchema.parse({
          ...room,
          players: room.players.map((p) =>
            p.id === playerId ? { ...p, reconnectDeadline: null } : p,
          ),
        }),
      };
    const result = definition.rules.eliminateSeat(room.game, player.color, reason);
    recordGomokuTransition(this.storage, room, result);
    if (result.state.status === "finished") return this.accept(room, result.state, at, true);
    const input = gomokuRoomSchema.parse({
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

  cpu(room: Playing, now: number): Result {
    if (room.clock.turnStartedAt + cpuMoveDelayMs > now || isClockExpired(room.clock, now))
      return { kind: "unchanged", gameId: "gomoku", room };
    const cpu = room.players.find((p) => p.color === room.game.turn);
    if (cpu?.kind !== "cpu") return { kind: "unchanged", gameId: "gomoku", room };
    const job = this.storage.kv.get<GomokuCpuJob>(gomokuCpuJobKey);
    if (job) {
      if (
        job.roundId !== room.roundId ||
        job.positionRevision !== room.positionRevision ||
        job.color !== room.game.turn
      ) {
        this.storage.kv.delete(gomokuCpuJobKey);
      } else if (job.applyAt <= now) {
        const result = definition.rules.applyAction(room.game, job.color, {
          type: "placeStone",
          position: job.move,
        });
        if (!result.ok) throw new Error("Saved CPU move is no longer legal");
        recordGomokuTransition(this.storage, room, result);
        return this.accept(room, result.state, now, true);
      }
    } else {
      const action = definition.cpu.chooseAction(room.game, cpu.color, cpu.level, Math.random);
      if (action === null) throw new Error("CPU has no legal move");
      // Workersの同期計算中は時刻が進まないため、次のAlarmで期限を再確認します。
      this.storage.kv.put(gomokuCpuJobKey, {
        roundId: room.roundId,
        positionRevision: room.positionRevision,
        color: room.game.turn,
        move: action.position,
        applyAt: Date.now() + 1,
      } satisfies GomokuCpuJob);
    }
    return { kind: "unchanged", gameId: "gomoku", room };
  }

  finalize(result: FinishedProgress<"gomoku">): LastRound {
    return finalizeGomokuRound(this.storage, result.room, result.game, result.at);
  }

  waiting(data: RematchFor<"gomoku">, players: GomokuRoom["players"]): WaitingFor<"gomoku"> {
    const room = gomokuRoomSchema.parse({
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
}
