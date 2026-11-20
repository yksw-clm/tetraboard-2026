import type { EliminationReason } from "@tetraboard/game-contract";
import type { GameActionCommandFor, GameId, RoomFor } from "@tetraboard/protocol";
import {
  applyGameCommand,
  applyProgressElimination,
  checkProgressCommand,
  type CommandPosition,
} from "./gameProgressCommands";
import { progressCpu } from "./gameProgressCpu";
import {
  acceptProgressState,
  expectPlaying,
  waitingProgressRoom,
  type ProgressAcceptance,
} from "./gameProgressRoom";
import type { FinishedProgress, ProgressFor, RematchFor, WaitingFor } from "./gameProgress";
import {
  readProgressState,
  type GameProgressSpec,
  type PreparedLeave,
  type ProgressGameTypes,
  type ProgressPlayingRoom,
  type ProgressRoom,
  type ProgressTransition,
} from "./gameProgressSpec";
import { nextPublicUpdateAt } from "./ports";

type RecordedLeave<G extends GameId, Prepared> = Prepared & Pick<ProgressAcceptance<G>, "saved">;

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
    if (this.spec.useActionRules)
      return this.command(room, tokenHash, this.spec.toAction(command), command);
    const positionMatches =
      room.roundId === command.roundId && room.positionRevision === command.positionRevision;
    const { error } = checkProgressCommand(this.spec, room, tokenHash, "play", positionMatches);
    if (error) return { kind: "rejected", error };
    const playing = expectPlaying(room);
    return this.applyCommand(playing, playing.game.turn, this.spec.toAction(command));
  }

  command(
    room: ProgressRoom<G, T>,
    tokenHash: string,
    action: T["action"],
    position: CommandPosition,
  ): ProgressFor<G> {
    const { error, player } = checkProgressCommand(
      this.spec,
      room,
      tokenHash,
      "play",
      position,
      action,
    );
    if (error) return { kind: "rejected", error };
    const seat = player ? this.spec.seat(player) : null;
    if (room.status !== "playing" || seat === null) throw new Error("Expected playing seat");
    return this.applyCommand(room, seat, action, true);
  }

  private applyCommand(
    room: ProgressPlayingRoom<G, T>,
    seat: T["seat"],
    action: T["action"],
    useActionRules = false,
  ): ProgressFor<G> {
    const { result, state } = applyGameCommand(this.spec, room, seat, action);
    if (!result.ok) return { kind: "rejected", error: this.spec.moveError(result.reason, action) };
    if (useActionRules) {
      if (result.state === state) return { kind: "unchanged", gameId: this.spec.gameId, room };
      const at = this.spec.now();
      const turnEnded = this.spec.definition.rules.endsTurn?.(action) ?? true;
      return this.acceptTransition(room, result, at, turnEnded);
    }
    const saved = this.spec.store.recordTransition(room, result) ?? undefined;
    return this.accept(room, result.state, this.spec.now(), true, { saved });
  }

  resign(room: ProgressRoom<G, T>, tokenHash: string): ProgressFor<G> {
    const { error, player } = checkProgressCommand(this.spec, room, tokenHash, "resign", true);
    if (error) return { kind: "rejected", error };
    if (this.spec.updatePlayersOnElimination) {
      if (room.status !== "playing" || !player) throw new Error("Expected playing seat");
      return this.eliminate(room, player.id, "resigned", this.spec.now());
    }
    const playing = expectPlaying(room);
    const { transition, saved } = this.recordElimination(playing, playing.game.turn, "resigned");
    return this.accept(playing, transition.state, this.spec.now(), true, { saved });
  }

  isEliminated(room: ProgressRoom<G, T>, playerId: string): boolean {
    if (room.status !== "playing") return false;
    const player = room.players.find((p) => p.id === playerId);
    const seat = player ? this.spec.seat(player) : null;
    return seat !== null && this.spec.inactiveSeats(room.game).includes(seat);
  }

  acceptTransition(
    room: ProgressPlayingRoom<G, T>,
    transition: ProgressTransition<T>,
    at: number,
    turnEnded: boolean,
  ): ProgressFor<G> {
    const saved = this.spec.store.recordTransition(room, transition) ?? undefined;
    return this.accept(room, transition.state, at, turnEnded, { saved });
  }

  accept(
    room: ProgressPlayingRoom<G, T>,
    state: T["state"],
    at: number,
    turnEnded: boolean,
    options?: ProgressAcceptance<G>,
  ): ProgressFor<G> {
    return acceptProgressState(this.spec, room, state, at, turnEnded, options);
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
    const transition = applyProgressElimination(this.spec, room, seat, reason);
    const saved = this.spec.store.recordTransition(room, transition) ?? undefined;
    return { transition, saved };
  }

  prepareLeave(
    room: ProgressPlayingRoom<G, T>,
    playerId: string,
  ): RecordedLeave<G, Prepared> | null {
    const seat = this.playerSeat(room, playerId);
    if (this.spec.inactiveSeats(room.game).includes(seat)) return null;
    const { transition, saved } = this.recordElimination(room, seat, "left");
    const prepared = this.spec.prepareLeaveResult(transition);
    return saved === undefined ? prepared : { ...prepared, saved };
  }

  leave(
    room: ProgressPlayingRoom<G, T>,
    playerId: string,
    prepared: RecordedLeave<G, Prepared> | null,
    at: number,
    hostLeaving: boolean,
  ): ProgressFor<G> {
    const saved = prepared?.saved;
    if (prepared?.state.status === "finished")
      return this.accept(room, prepared.state, at, true, { saved });
    const input = expectPlaying(
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
      prepared?.state ?? readProgressState(this.spec, preservePosition ? input : room),
      at,
      !!prepared && prepared.state.turn !== room.game.turn,
      { positionChanged: !preservePosition, saved },
    );
  }

  eliminate(
    room: ProgressPlayingRoom<G, T>,
    playerId: string,
    reason: EliminationReason,
    at: number,
  ): ProgressFor<G> {
    const { gameId, parseRoom, inactiveSeats } = this.spec;
    const seat = this.playerSeat(room, playerId);
    if (this.spec.updatePlayersOnElimination)
      return this.eliminateWithUpdatedPlayers(room, playerId, seat, reason, at);
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
    const { transition, saved } = this.recordElimination(room, seat, reason);
    const { state } = transition;
    if (state.status === "finished") return this.accept(room, state, at, true, { saved });
    const input = parseRoom({
      ...room,
      players: room.players.map((p) =>
        p.id === playerId && reason === "disconnected" ? { ...p, reconnectDeadline: null } : p,
      ),
    });
    return this.accept(
      expectPlaying(input),
      state,
      at,
      reason === "timeout" || state.turn !== room.game.turn,
      { saved },
    );
  }

  private eliminateWithUpdatedPlayers(
    room: ProgressPlayingRoom<G, T>,
    playerId: string,
    seat: T["seat"],
    reason: EliminationReason,
    at: number,
  ): ProgressFor<G> {
    const clearDeadline = reason === "left" || reason === "disconnected";
    const players = room.players.map((player) => ({
      ...player,
      reconnectDeadline: player.id === playerId && clearDeadline ? null : player.reconnectDeadline,
    }));
    if (this.isEliminated(room, playerId))
      return {
        kind: "unchanged",
        gameId: this.spec.gameId,
        room: this.spec.parseRoom({ ...room, players }),
      };
    const transition = applyProgressElimination(this.spec, room, seat, reason);
    const input = expectPlaying(this.spec.parseRoom({ ...room, players }));
    return this.acceptTransition(input, transition, at, transition.state.turn !== room.game.turn);
  }

  cpu(room: ProgressPlayingRoom<G, T>, now: number): ProgressFor<G> {
    return progressCpu(this.spec, room, now, (transition) =>
      this.acceptTransition(room, transition, now, true),
    );
  }

  finalize(result: FinishedProgress<G>) {
    return this.spec.store.finalize(result);
  }

  waiting(data: RematchFor<G>, players: RoomFor<G>["players"]): WaitingFor<G> {
    return waitingProgressRoom(this.spec, data, players);
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
