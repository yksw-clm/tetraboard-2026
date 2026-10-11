import { chooseCpuMove } from "@tetraboard/four-gomoku/cpu";
import {
  fourGomokuStateSchema,
  fourGomokuRoomSchema,
  fourGomokuReplaySchema as roundReplaySchema,
  type FourGomokuRoom,
  type FourGomokuLastRound as LastRound,
  type FourGomokuReplay as RoundReplay,
  type GameActionCommandFor,
} from "@tetraboard/protocol";
import {
  applyAction,
  colors,
  getActiveColors,
  createInitialState,
  eliminateColor,
  type FourGomokuState,
  type Color,
  type Position,
} from "@tetraboard/four-gomoku";
import { advanceClock, createClock, isClockExpired } from "./clock";
import {
  matchStartKey,
  pendingMatchPrefix,
  type MatchStart,
  type PendingMatch,
} from "./fourGomokuMatchStore";
import {
  roomStorageKey,
  replayKey,
  playerLabel,
  playerAppearance,
  nextPublicUpdateAt,
  shuffledAssignments,
  cpuMoveDelayMs,
} from "./progressHelpers";
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

  start(room: WaitingFor<"four-gomoku">): { room: Playing; roundId: string; at: number } {
    this.storage.kv.delete(fourGomokuCpuJobKey);
    const assignments = shuffledAssignments(colors);
    const startedAtMs = Date.now();
    const matchId = crypto.randomUUID();
    const startedRoom = fourGomokuRoomSchema.parse({
      ...room,
      status: "playing",
      roundId: matchId,
      positionRevision: 0,
      eliminations: [],
      publicUpdatedAtMs: nextPublicUpdateAt(room),
      lastActivityAtMs: startedAtMs,
      lastRound: null,
      players: room.players.map((player, index) => ({
        ...player,
        ready: player.kind === "cpu" ? true : false,
        color: assignments[index],
      })),
      game: createInitialState(room.settings.mode),
      clock: createClock(startedAtMs, room.settings.timeControl),
    });
    this.storage.kv.put(roomStorageKey, startedRoom);
    this.storage.kv.put(
      replayKey,
      roundReplaySchema.parse({
        id: matchId,
        initial: startedRoom.game,
        steps: [],
      }),
    );
    if (startedRoom.status !== "playing") throw new Error("Game did not start");
    this.storage.kv.put(matchStartKey, {
      id: matchId,
      roomId: startedRoom.id,
      instanceId: startedRoom.instanceId,
      startedAtMs,
      settings: startedRoom.settings,
      participants: startedRoom.players.map((player, seat) => ({
        id: player.id,
        name: playerLabel(player),
        color: player.color,
        seat,
        ...(player.kind === "cpu"
          ? { kind: "cpu" as const, level: player.level }
          : {
              kind: "human" as const,
              accountId: this.accountId(player.id),
            }),
      })),
    } satisfies MatchStart);
    return { room: startedRoom, roundId: matchId, at: startedAtMs };
  }

  play(
    room: FourGomokuRoom,
    tokenHash: string,
    command: GameActionCommandFor<"four-gomoku">,
  ): Result {
    const action = command.action;
    if (room.status === "waiting")
      return { kind: "rejected", error: room.lastRound ? "game_finished" : "game_not_started" };
    if (isClockExpired(room.clock, Date.now())) return { kind: "rejected", error: "time_expired" };

    const membership = this.membership(tokenHash);
    if (membership === null) return { kind: "rejected", error: "unauthorized" };
    const player = room.players.find((entry) => entry.id === membership.playerId);
    if (player !== undefined && !getActiveColors(room.game).includes(player.color)) {
      return { kind: "rejected", error: "already_eliminated" };
    }
    if (player?.color !== room.game.turn) return { kind: "rejected", error: "not_your_turn" };
    if (room.roundId !== command.roundId || room.positionRevision !== command.positionRevision)
      return { kind: "rejected", error: "stale_position" };
    const result = applyAction(room.game, { type: "placeStone", position: action.position });
    if (!result.ok) return { kind: "rejected", error: "invalid_move" };
    this.recordReplayStep(
      { type: "place", color: room.game.turn, position: action.position },
      result,
    );
    const at = Date.now();
    return this.accept(room, result.state, at, true);
  }

  resign(room: FourGomokuRoom, tokenHash: string): Result {
    if (room.status === "waiting")
      return { kind: "rejected", error: room.lastRound ? "game_finished" : "game_not_started" };
    if (isClockExpired(room.clock, Date.now())) return { kind: "rejected", error: "time_expired" };
    const membership = this.membership(tokenHash);
    if (membership === null) return { kind: "rejected", error: "unauthorized" };
    const player = room.players.find((entry) => entry.id === membership.playerId);
    if (player === undefined) return { kind: "rejected", error: "unauthorized" };
    if (!getActiveColors(room.game).includes(player.color)) {
      return { kind: "rejected", error: "already_eliminated" };
    }
    if (room.game.turn !== player.color) return { kind: "rejected", error: "not_your_turn" };
    const result = eliminateColor(room.game, player.color);
    if (!result.ok) throw new Error("Could not resign current player");
    this.recordElimination(room, player.color, "resigned", result);
    const at = Date.now();
    return this.accept(room, result.state, at, true);
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

  prepareLeave(room: Playing, playerId: string) {
    const player = room.players.find((p) => p.id === playerId);
    if (!player) throw new Error("Unknown FourGomoku player");
    if (!getActiveColors(room.game).includes(player.color)) return null;
    const result = eliminateColor(room.game, player.color, "left");
    if (!result.ok) throw new Error("Could not eliminate leaving player");
    this.recordElimination(room, player.color, "left", result);
    return result;
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
    const result = eliminateColor(room.game, player.color, reason);
    if (!result.ok) throw new Error("Could not eliminate player");
    this.recordElimination(room, player.color, reason, result);
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
        const result = applyAction(room.game, { type: "placeStone", position: job.move });
        if (!result.ok) throw new Error("Saved CPU move is no longer legal");
        this.recordReplayStep({ type: "place", color: room.game.turn, position: job.move }, result);
        return this.accept(room, result.state, now, true);
      }
    } else {
      const move = chooseCpuMove(room.game, cpu.level);
      if (move === null) throw new Error("CPU has no legal move");
      // Workersの同期計算中は時刻が進まないため、次のAlarmで期限を再確認します。
      this.storage.kv.put(fourGomokuCpuJobKey, {
        roundId: room.roundId,
        positionRevision: room.positionRevision,
        color: room.game.turn,
        move,
        applyAt: Date.now() + 1,
      } satisfies FourGomokuCpuJob);
    }
    return { kind: "unchanged", gameId: "four-gomoku", room };
  }

  finalize(result: FinishedProgress<"four-gomoku">): LastRound {
    return this.finalizeResult(result.room, result.game, result.at);
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

  private recordElimination(
    room: Extract<FourGomokuRoom, { status: "playing" }>,
    color: Color,
    reason: FourGomokuRoom["eliminations"][number]["reason"],
    result: { state: FourGomokuState },
  ): void {
    // 呼び出し元のトランザクションで、理由を盤面・棋譜と一緒に保存します。
    room.eliminations.push({ color, reason });
    this.recordReplayStep({ type: "eliminate", color, reason }, result);
  }

  private recordReplayStep(
    action: RoundReplay["steps"][number]["action"],
    result: { state: FourGomokuState },
  ): void {
    const saved = this.storage.kv.get(replayKey);
    if (saved === undefined) throw new Error("Missing FourGomoku replay");
    const replay = roundReplaySchema.parse(saved);
    replay.steps.push(
      roundReplaySchema.shape.steps.element.parse({
        action,
        game: result.state,
      }),
    );
    this.storage.kv.put(replayKey, replay);
  }

  private finalizeResult(
    room: Extract<FourGomokuRoom, { status: "playing" }>,
    game: LastRound["game"],
    at: number,
  ): LastRound {
    const start = this.storage.kv.get<MatchStart>(matchStartKey);
    const replay = this.storage.kv.get<RoundReplay>(replayKey);
    if (start && replay && start.id === replay.id) {
      this.storage.kv.put(`${pendingMatchPrefix}${start.id}`, {
        record: { ...start, endedAtMs: at, game, eliminations: room.eliminations, replay },
        retryAtMs: Date.now(),
      } satisfies PendingMatch);
    }
    this.storage.kv.delete(matchStartKey);
    const lastRound: LastRound = {
      settings: room.settings,
      game,
      replay: roundReplaySchema.parse(this.storage.kv.get<RoundReplay>(replayKey)),
      players: room.players.map((player) => ({
        id: player.id,
        name: playerLabel(player),
        color: player.color,
        appearance: playerAppearance(player),
      })),
    };
    this.storage.kv.delete(replayKey);
    return lastRound;
  }
}
