import {
  fourReversiStateSchema,
  fourReversiRoomSchema,
  roundReplaySchema,
  type FourReversiRoom,
  type LastRound,
  type RoundReplay,
  type GameActionCommandFor,
} from "@tetraboard/protocol";
import {
  applyAction,
  chooseCpuMove,
  colors,
  createInitialState,
  eliminateColor,
  type FourReversiState,
  type Color,
} from "@tetraboard/four-reversi";
import { advanceClock, createClock, isClockExpired } from "./clock";
import {
  matchStartKey,
  pendingMatchPrefix,
  type MatchStart,
  type PendingMatch,
} from "./matchStore";
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
type Playing = PlayingFor<"four-reversi">;
type Result = ProgressFor<"four-reversi">;
export class FourReversiProgress {
  private readonly storage: DurableObjectStorage;
  private readonly membership: ProgressDependencies["membership"];
  private readonly accountId: ProgressDependencies["accountId"];
  constructor(dependencies: ProgressDependencies) {
    this.storage = dependencies.storage;
    this.membership = dependencies.membership;
    this.accountId = dependencies.accountId;
  }

  start(room: WaitingFor<"four-reversi">): { room: Playing; roundId: string; at: number } {
    const assignments = shuffledAssignments(colors);
    const startedAtMs = Date.now();
    const matchId = crypto.randomUUID();
    const startedRoom = fourReversiRoomSchema.parse({
      ...room,
      status: "playing",
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
    room: FourReversiRoom,
    tokenHash: string,
    command: GameActionCommandFor<"four-reversi">,
  ): Result {
    const action = command.action;
    if (room.status === "waiting")
      return { kind: "rejected", error: room.lastRound ? "game_finished" : "game_not_started" };
    if (isClockExpired(room.clock, Date.now())) return { kind: "rejected", error: "time_expired" };

    const membership = this.membership(tokenHash);
    if (membership === null) return { kind: "rejected", error: "unauthorized" };
    const player = room.players.find((entry) => entry.id === membership.playerId);
    if (player !== undefined && room.game.eliminatedColors.includes(player.color)) {
      return { kind: "rejected", error: "already_eliminated" };
    }
    if (player?.color !== room.game.turn) return { kind: "rejected", error: "not_your_turn" };
    const result = applyAction(room.game, action);
    if (!result.ok) return { kind: "rejected", error: "invalid_move" };
    this.recordReplayStep(
      { type: "place", color: room.game.turn, position: action.position },
      result,
    );
    const at = Date.now();
    return this.accept(room, result.state, at, true);
  }

  resign(room: FourReversiRoom, tokenHash: string): Result {
    if (room.status === "waiting")
      return { kind: "rejected", error: room.lastRound ? "game_finished" : "game_not_started" };
    if (isClockExpired(room.clock, Date.now())) return { kind: "rejected", error: "time_expired" };
    const membership = this.membership(tokenHash);
    if (membership === null) return { kind: "rejected", error: "unauthorized" };
    const player = room.players.find((entry) => entry.id === membership.playerId);
    if (player === undefined) return { kind: "rejected", error: "unauthorized" };
    if (room.game.eliminatedColors.includes(player.color)) {
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
    state: FourReversiState,
    at: number,
    turnEnded: boolean,
    clockAt = at,
  ): Result {
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
    const result = eliminateColor(room.game, player.color);
    if (!result.ok) throw new Error("Could not eliminate leaving player");
    this.recordElimination(room, player.color, "left", result);
    return result;
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
    const result = eliminateColor(room.game, player.color);
    if (!result.ok) throw new Error("Could not eliminate player");
    this.recordElimination(room, player.color, reason, result);
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

  cpu(room: Playing, now: number): Result {
    if (room.clock.turnStartedAt + cpuMoveDelayMs > now || isClockExpired(room.clock, now))
      return { kind: "unchanged", gameId: "four-reversi", room };
    const cpu = room.players.find((p) => p.color === room.game.turn);
    if (cpu?.kind !== "cpu") return { kind: "unchanged", gameId: "four-reversi", room };
    const move = chooseCpuMove(room.game, cpu.level);
    if (move === null) throw new Error("CPU has no legal move");
    const decidedAt = Date.now();
    const expired = isClockExpired(room.clock, decidedAt);
    const result = expired
      ? eliminateColor(room.game, room.game.turn)
      : applyAction(room.game, { type: "placeStone", position: move });
    if (!result.ok) throw new Error("CPU selected an invalid move");
    if (expired) this.recordElimination(room, room.game.turn, "timeout", result);
    else this.recordReplayStep({ type: "place", color: room.game.turn, position: move }, result);
    return this.accept(
      room,
      result.state,
      decidedAt,
      true,
      expired ? room.clock.turnExpiresAt : decidedAt,
    );
  }

  finalize(result: FinishedProgress<"four-reversi">): LastRound {
    return this.finalizeResult(result.room, result.game, result.at);
  }

  waiting(
    data: RematchFor<"four-reversi">,
    players: FourReversiRoom["players"],
  ): WaitingFor<"four-reversi"> {
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

  normalize(room: FourReversiRoom, saved: object): void {
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

  private recordElimination(
    room: Extract<FourReversiRoom, { status: "playing" }>,
    color: Color,
    reason: FourReversiRoom["eliminations"][number]["reason"],
    result: { state: FourReversiState; passedColors: readonly Color[] },
  ): void {
    // 呼び出し元のトランザクションで、理由を盤面・棋譜と一緒に保存します。
    room.eliminations.push({ color, reason });
    this.recordReplayStep({ type: "eliminate", color, reason }, result);
  }

  private recordReplayStep(
    action: RoundReplay["steps"][number]["action"],
    result: { state: FourReversiState; passedColors: readonly Color[] },
  ): void {
    const saved = this.storage.kv.get(replayKey);
    // 記録導入前に開始した対局の棋譜は、途中から補完しません。
    if (saved === undefined) return;
    const replay = roundReplaySchema.parse(saved);
    replay.steps.push(
      roundReplaySchema.shape.steps.element.parse({
        action,
        game: result.state,
        passedColors: result.passedColors,
      }),
    );
    this.storage.kv.put(replayKey, replay);
  }

  private finalizeResult(
    room: Extract<FourReversiRoom, { status: "playing" }>,
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
      game,
      replay: this.storage.kv.get<RoundReplay>(replayKey) ?? null,
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
