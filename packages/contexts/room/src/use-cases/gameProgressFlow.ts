import type { EliminationReason } from "@tetraboard/game-contract";
import type { GameActionCommandFor, GameId, RoomFor } from "@tetraboard/protocol";
import { checkGameCommand } from "../domain";
import type { FinishedProgress, ProgressFor, RematchFor, WaitingFor } from "./gameProgress";
import type {
  GameProgressSpec,
  PreparedLeave,
  ProgressCpuJob,
  ProgressCpuJobs,
  ProgressGameTypes,
  ProgressPlayingRoom,
  ProgressRoom,
} from "./gameProgressSpec";
import { nextPublicUpdateAt } from "./ports";
import { cpuMoveDelayMs } from "./processDeadlines";

class GameProgress<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[] = [],
  Prepared extends PreparedLeave<T> = PreparedLeave<T>,
> {
  constructor(private readonly spec: GameProgressSpec<G, T, StartArgs, Prepared>) {}

  start(room: WaitingFor<G>, ...args: StartArgs) {
    this.spec.store.cpuJobs?.delete();
    return this.spec.store.start(room, this.spec.accountId, ...args);
  }

  play(
    room: ProgressRoom<G, T>,
    tokenHash: string,
    command: GameActionCommandFor<G>,
  ): ProgressFor<G> {
    const error = this.checkCommand(
      room,
      tokenHash,
      "play",
      room.roundId === command.roundId && room.positionRevision === command.positionRevision,
    );
    if (error) return { kind: "rejected", error };
    const playing = this.expectPlaying(room);
    const result = this.spec.definition.rules.applyAction(
      playing.game,
      playing.game.turn,
      this.spec.toAction(command),
    );
    if (!result.ok) return { kind: "rejected", error: this.spec.moveError(result.reason) };
    this.spec.store.recordTransition(playing, result);
    return this.accept(playing, result.state, this.spec.now(), true);
  }

  resign(room: ProgressRoom<G, T>, tokenHash: string): ProgressFor<G> {
    const error = this.checkCommand(room, tokenHash, "resign", true);
    if (error) return { kind: "rejected", error };
    const playing = this.expectPlaying(room);
    const { state } = this.recordElimination(playing, playing.game.turn, "resigned");
    return this.accept(playing, state, this.spec.now(), true);
  }

  private checkCommand(
    room: ProgressRoom<G, T>,
    tokenHash: string,
    operation: "play" | "resign",
    positionMatches: boolean,
  ) {
    const { definition, inactiveSeats, isClockExpired, membership, now, seat } = this.spec;
    const member = membership(tokenHash);
    const player = room.players.find((p) => p.id === member?.playerId);
    return checkGameCommand({
      operation,
      status: room.status,
      hasLastRound: room.lastRound !== null,
      seat: player ? seat(player) : null,
      eliminatedSeats: room.game === null ? [] : inactiveSeats(room.game),
      turn: room.game === null ? null : definition.rules.getTurn(room.game),
      positionMatches,
      clockExpired: room.clock !== null && isClockExpired(room.clock, now()),
    });
  }

  private expectPlaying(room: ProgressRoom<G, T>): ProgressPlayingRoom<G, T> {
    if (room.status !== "playing") throw new Error("Expected playing room");
    return room;
  }

  // 操作や脱落を記録した後、その状態をルームに反映します。
  accept(
    room: ProgressPlayingRoom<G, T>,
    state: T["state"],
    at: number,
    turnEnded: boolean,
    { clockAt = at, positionChanged = true } = {},
  ): ProgressFor<G> {
    const { store, gameId, parseFinishedState, parseRoom, advanceClock } = this.spec;
    if (this.spec.clearCpuJobsOnAccept) this.spec.clearCpuJobsOnAccept();
    else store.cpuJobs?.delete();
    const positionRevision = room.positionRevision + (positionChanged ? 1 : 0);
    if (state.status === "finished") {
      const game = parseFinishedState(state);
      const finishedRoom = this.spec.incrementRevisionOnFinish
        ? { ...room, positionRevision }
        : room;
      return { kind: "finished", gameId, room: finishedRoom, game, at };
    }

    const updated = parseRoom({
      ...room,
      game: state,
      positionRevision,
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
    return { kind: "playing", gameId, room: this.expectPlaying(updated) };
  }

  private playerSeat(room: ProgressPlayingRoom<G, T>, playerId: string): T["seat"] {
    const player = room.players.find((p) => p.id === playerId);
    const seat = player ? this.spec.seat(player) : null;
    if (seat === null) throw new Error(this.spec.unknownPlayerMessage);
    return seat;
  }

  private recordElimination(
    room: ProgressPlayingRoom<G, T>,
    seat: T["seat"],
    reason: EliminationReason,
  ) {
    const result = this.spec.definition.rules.eliminateSeat(room.game, seat, reason);
    this.spec.store.recordTransition(room, result);
    return result;
  }

  prepareLeave(room: ProgressPlayingRoom<G, T>, playerId: string): Prepared | null {
    const seat = this.playerSeat(room, playerId);
    if (this.spec.inactiveSeats(room.game).includes(seat)) return null;
    return this.spec.prepareLeaveResult(this.recordElimination(room, seat, "left"));
  }

  leave(
    room: ProgressPlayingRoom<G, T>,
    playerId: string,
    prepared: Prepared | null,
    at: number,
    hostLeaving: boolean,
  ): ProgressFor<G> {
    if (prepared?.state.status === "finished") return this.accept(room, prepared.state, at, true);
    const input = this.expectPlaying(
      this.spec.parseRoom({
        ...room,
        publicUpdatedAtMs: hostLeaving
          ? nextPublicUpdateAt(room, this.spec.now())
          : room.publicUpdatedAtMs,
        players: room.players.map((p) => ({
          ...p,
          reconnectDeadline: p.id === playerId ? null : p.reconnectDeadline,
        })),
      }),
    );
    const preservePosition = prepared === null && this.spec.preservePositionOnInactiveLeave;
    return this.accept(
      input,
      prepared?.state ?? (preservePosition ? input.game : room.game),
      at,
      !!prepared && prepared.state.turn !== room.game.turn,
      { positionChanged: !preservePosition },
    );
  }

  eliminate(
    room: ProgressPlayingRoom<G, T>,
    playerId: string,
    reason: "timeout" | "disconnected",
    at: number,
  ): ProgressFor<G> {
    const { gameId, parseRoom, inactiveSeats } = this.spec;
    const seat = this.playerSeat(room, playerId);
    if (reason === "disconnected" && inactiveSeats(room.game).includes(seat))
      return {
        kind: "unchanged",
        gameId,
        room: parseRoom({
          ...room,
          players: room.players.map((p) =>
            p.id === playerId ? { ...p, reconnectDeadline: null } : p,
          ),
        }),
      };
    const { state } = this.recordElimination(room, seat, reason);
    if (state.status === "finished") return this.accept(room, state, at, true);
    const input = parseRoom({
      ...room,
      players: room.players.map((p) =>
        p.id === playerId && reason === "disconnected" ? { ...p, reconnectDeadline: null } : p,
      ),
    });
    return this.accept(
      this.expectPlaying(input),
      state,
      at,
      reason === "timeout" || state.turn !== room.game.turn,
    );
  }

  cpu(room: ProgressPlayingRoom<G, T>, now: number): ProgressFor<G> {
    const { gameId, definition, isClockExpired, random = Math.random, seat, store } = this.spec;
    const jobs = store.cpuJobs;
    const unchanged = { kind: "unchanged", gameId, room } as const;
    if (!jobs) return unchanged;
    if (room.clock.turnStartedAt + cpuMoveDelayMs > now || isClockExpired(room.clock, now))
      return unchanged;
    const turn = room.game.turn;
    const cpu = room.players.find((p) => seat(p) === turn);
    if (cpu?.kind !== "cpu") return unchanged;
    const job = jobs.read();
    if (job) return this.applyCpuJob(room, job, now, jobs);
    const action = definition.cpu.chooseAction(room.game, turn, cpu.level, random);
    if (action === null) throw new Error("CPU has no legal move");
    // Workersの同期計算中は時刻が進まないため、次のAlarmで期限を再確認します。
    jobs.write({
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      seat: turn,
      action,
      applyAt: this.spec.now() + 1,
    });
    return unchanged;
  }

  private applyCpuJob(
    room: ProgressPlayingRoom<G, T>,
    job: ProgressCpuJob<T>,
    now: number,
    jobs: ProgressCpuJobs<T>,
  ): ProgressFor<G> {
    const { store, gameId, definition } = this.spec;
    if (
      job.roundId !== room.roundId ||
      job.positionRevision !== room.positionRevision ||
      job.seat !== room.game.turn
    ) {
      jobs.delete();
    } else if (job.applyAt <= now) {
      const result = definition.rules.applyAction(room.game, job.seat, job.action);
      if (!result.ok) throw new Error("Saved CPU move is no longer legal");
      store.recordTransition(room, result);
      return this.accept(room, result.state, now, true);
    }
    return { kind: "unchanged", gameId, room };
  }

  finalize(result: FinishedProgress<G>) {
    return this.spec.store.finalize(result);
  }

  waiting(data: RematchFor<G>, players: RoomFor<G>["players"]): WaitingFor<G> {
    const room = this.spec.parseRoom({
      ...data.room,
      status: "waiting",
      roundId: null,
      positionRevision: 0,
      eliminations: [],
      publicUpdatedAtMs: nextPublicUpdateAt(data.room, this.spec.now()),
      lastActivityAtMs: data.at,
      players: players.map((p) => ({ ...p, ...this.spec.waitingSeat })),
      game: null,
      clock: null,
      lastRound: data.lastRound,
    });
    if (room.status !== "waiting") throw new Error("Expected waiting room");
    return room;
  }
}

export function createGameProgress<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[] = [],
  Prepared extends PreparedLeave<T> = PreparedLeave<T>,
>(spec: GameProgressSpec<G, T, StartArgs, Prepared>) {
  return new GameProgress(spec);
}
