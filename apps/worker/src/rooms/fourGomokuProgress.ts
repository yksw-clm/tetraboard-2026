import type { TournamentRoomContext } from "./tournamentRoom";
import { checkGameCommand } from "@tetraboard/context-room";
import { gameDefinitions } from "./gameDefinitions";
import {
  startFourGomokuRound,
  recordFourGomokuTransition,
  finalizeFourGomokuRound,
} from "./fourGomokuProgressStore";
import {
  fourGomokuStateSchema,
  fourGomokuRoomSchema,
  type FourGomokuRoom,
  type FourGomokuLastRound as LastRound,
  type FourGomokuReplay as RoundReplay,
  type GameActionCommandFor,
} from "@tetraboard/protocol";
import {
  type ActionResult,
  getActiveColors,
  type FourGomokuState,
  type Color,
  type Position,
} from "@tetraboard/four-gomoku";
import { advanceClock, isClockExpired } from "./clock";
import { replayKey, nextPublicUpdateAt, cpuMoveDelayMs } from "./progressHelpers";
import type {
  ProgressDependencies,
  ProgressFor,
  PlayingFor,
  WaitingFor,
  FinishedProgress,
  RematchFor,
} from "./gameProgress";
type Playing = PlayingFor<"four-gomoku">;
type Result = ProgressFor<"four-gomoku">;
const definition = gameDefinitions["four-gomoku"];
export const fourGomokuCpuJobKey = "four-gomoku-cpu-job";
export type FourGomokuCpuJob = {
  roundId: string;
  positionRevision: number;
  color: Color;
  move: Position;
  applyAt: number;
};
export class FourGomokuProgress {
  private readonly storage: DurableObjectStorage;
  private readonly membership: ProgressDependencies["membership"];
  private readonly accountId: ProgressDependencies["accountId"];
  constructor(dependencies: ProgressDependencies) {
    this.storage = dependencies.storage;
    this.membership = dependencies.membership;
    this.accountId = dependencies.accountId;
  }

  normalize(room: FourGomokuRoom): void {
    if (room.status !== "playing" || room.game.lastMoves) return;
    // 旧局面には表示用の履歴がないため、永続棋譜の確定着手から復元します。
    const replay = this.storage.kv.get<RoundReplay>(replayKey);
    if (!replay || replay.id !== room.roundId) return;
    const lastMoves: Partial<Record<Color, Position>> = {};
    for (const { action } of replay.steps)
      if (action.type === "place") lastMoves[action.color] = action.position;
    room.game.lastMoves = lastMoves;
  }

  start(
    room: WaitingFor<"four-gomoku">,
    tournament?: TournamentRoomContext,
  ): { room: Playing; roundId: string; at: number } {
    this.storage.kv.delete(fourGomokuCpuJobKey);
    return startFourGomokuRound(this.storage, room, this.accountId, tournament);
  }

  play(
    room: FourGomokuRoom,
    tokenHash: string,
    command: GameActionCommandFor<"four-gomoku">,
  ): Result {
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
    if (!result.ok) return { kind: "rejected", error: "invalid_move" };
    recordFourGomokuTransition(this.storage, room, result);
    return this.accept(room, result.state, Date.now(), true);
  }

  resign(room: FourGomokuRoom, tokenHash: string): Result {
    const error = this.checkCommand(room, tokenHash, "resign", true);
    if (error) return { kind: "rejected", error };
    if (room.status !== "playing") throw new Error("Expected playing room");
    const result = definition.rules.eliminateSeat(room.game, room.game.turn, "resigned");
    recordFourGomokuTransition(this.storage, room, result);
    return this.accept(room, result.state, Date.now(), true);
  }

  private checkCommand(
    room: FourGomokuRoom,
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
      eliminatedSeats:
        room.game === null ? [] : [...room.game.eliminatedColors, ...room.game.completedColors],
      turn: room.game === null ? null : definition.rules.getTurn(room.game),
      positionMatches,
      clockExpired: room.clock !== null && isClockExpired(room.clock, Date.now()),
    });
  }

  private accept(
    room: Playing,
    state: FourGomokuState,
    at: number,
    turnEnded: boolean,
    clockAt = at,
  ): Result {
    this.storage.kv.delete(fourGomokuCpuJobKey);
    if (state.status === "finished") {
      const game = fourGomokuStateSchema.parse(state);
      if (game.status !== "finished") throw new Error("Expected finished state");
      return { kind: "finished", gameId: "four-gomoku", room, game, at };
    }
    const updated = fourGomokuRoomSchema.parse({
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
    return { kind: "playing", gameId: "four-gomoku", room: updated };
  }

  prepareLeave(room: Playing, playerId: string): Extract<ActionResult, { ok: true }> | null {
    const player = room.players.find((p) => p.id === playerId);
    if (!player) throw new Error("Unknown FourGomoku player");
    if (!getActiveColors(room.game).includes(player.color)) return null;
    const result = definition.rules.eliminateSeat(room.game, player.color, "left");
    recordFourGomokuTransition(this.storage, room, result);
    return { ok: true, state: result.state };
  }

  leave(
    room: Playing,
    playerId: string,
    prepared: ReturnType<FourGomokuProgress["prepareLeave"]>,
    at: number,
    hostLeaving: boolean,
  ): Result {
    if (prepared?.state.status === "finished") return this.accept(room, prepared.state, at, true);
    const input = fourGomokuRoomSchema.parse({
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
    if (!player) throw new Error("Unknown FourGomoku player");
    if (reason === "disconnected" && !getActiveColors(room.game).includes(player.color))
      return {
        kind: "unchanged",
        gameId: "four-gomoku",
        room: fourGomokuRoomSchema.parse({
          ...room,
          players: room.players.map((p) =>
            p.id === playerId ? { ...p, reconnectDeadline: null } : p,
          ),
        }),
      };
    const result = definition.rules.eliminateSeat(room.game, player.color, reason);
    recordFourGomokuTransition(this.storage, room, result);
    if (result.state.status === "finished") return this.accept(room, result.state, at, true);
    const input = fourGomokuRoomSchema.parse({
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
      return { kind: "unchanged", gameId: "four-gomoku", room };
    const cpu = room.players.find((p) => p.color === room.game.turn);
    if (cpu?.kind !== "cpu") return { kind: "unchanged", gameId: "four-gomoku", room };
    const job = this.storage.kv.get<FourGomokuCpuJob>(fourGomokuCpuJobKey);
    if (job) {
      if (
        job.roundId !== room.roundId ||
        job.positionRevision !== room.positionRevision ||
        job.color !== room.game.turn
      ) {
        this.storage.kv.delete(fourGomokuCpuJobKey);
      } else if (job.applyAt <= now) {
        const result = definition.rules.applyAction(room.game, job.color, {
          type: "placeStone",
          position: job.move,
        });
        if (!result.ok) throw new Error("Saved CPU move is no longer legal");
        recordFourGomokuTransition(this.storage, room, result);
        return this.accept(room, result.state, now, true);
      }
    } else {
      const action = definition.cpu.chooseAction(room.game, cpu.color, cpu.level, Math.random);
      if (action === null) throw new Error("CPU has no legal move");
      // Workersの同期計算中は時刻が進まないため、次のAlarmで期限を再確認します。
      this.storage.kv.put(fourGomokuCpuJobKey, {
        roundId: room.roundId,
        positionRevision: room.positionRevision,
        color: room.game.turn,
        move: action.position,
        applyAt: Date.now() + 1,
      } satisfies FourGomokuCpuJob);
    }
    return { kind: "unchanged", gameId: "four-gomoku", room };
  }

  finalize(result: FinishedProgress<"four-gomoku">): LastRound {
    return finalizeFourGomokuRound(this.storage, result.room, result.game, result.at);
  }

  waiting(
    data: RematchFor<"four-gomoku">,
    players: FourGomokuRoom["players"],
  ): WaitingFor<"four-gomoku"> {
    const room = fourGomokuRoomSchema.parse({
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
