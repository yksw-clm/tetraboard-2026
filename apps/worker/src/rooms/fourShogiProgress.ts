import { migrateLegacyFourShogiRoom } from "../adapters/room/legacyRoomMigrations";
import {
  fourShogiRoomSchema,
  isFourShogiRoom,
  type FourShogiRoom,
  type FourShogiReplayEvent,
  type Room,
  type FourShogiEliminatedHands,
  type RoomSocketClientMessage,
  type GameActionCommandFor,
} from "@tetraboard/protocol";
import {
  getActionAvailability,
  getCheckState,
  type FourShogiState,
  type ExternalEliminationReason,
} from "@tetraboard/four-shogi";
import {
  fourShogiDefinition as definition,
  type FourShogiGameAction,
} from "@tetraboard/four-shogi/definition";
import { checkGameCommand } from "@tetraboard/context-room";
import { ShogiStore } from "./shogiStore";
import type { TournamentRoomContext } from "@tetraboard/context-tournament";
import type { FourShogiRatingSource } from "@tetraboard/context-matchmaking";
import { advanceShogiClock } from "../adapters/room/shogiClock";
import { isClockExpired } from "../adapters/room/clock";
import { shogiCpuJobKey, nextPublicUpdateAt } from "./progressHelpers";
import type {
  ProgressDependencies,
  ProgressFor,
  PlayingFor,
  WaitingFor,
  FinishedProgress,
  RematchFor,
} from "./gameProgress";
import {
  FourShogiCpu,
  fourShogiAiJobKey,
  type FourShogiAiWork,
  type FourShogiCpuResponse,
} from "./fourShogiCpu";
import {
  startFourShogiRound,
  finalizeFourShogiRound,
  waitingFourShogiRoom,
} from "./fourShogiProgressStore";
import { shogiEliminatedHandsKey, saveFourShogiTransition } from "./fourShogiProgressRecords";
export { shogiEliminatedHandsKey } from "./fourShogiProgressRecords";
export { fourShogiAiJobKey, type FourShogiAiWork, type ShogiCpuJob } from "./fourShogiCpu";
export const eliminatedHandsTag = "eliminated-hands-v1";
type Playing = PlayingFor<"four-shogi">;
type Result = ProgressFor<"four-shogi">;
export class FourShogiProgress {
  private readonly storage: DurableObjectStorage;
  private readonly membership: ProgressDependencies["membership"];
  private readonly accountId: ProgressDependencies["accountId"];
  private readonly cpuProgress: FourShogiCpu;
  private shogiStore: ShogiStore | null = null;
  constructor(dependencies: ProgressDependencies) {
    this.storage = dependencies.storage;
    this.cpuProgress = new FourShogiCpu(this.storage, () => this.store());
    this.membership = dependencies.membership;
    this.accountId = dependencies.accountId;
  }

  store(): ShogiStore {
    return (this.shogiStore ??= new ShogiStore(this.storage.sql));
  }

  displayHands(
    room: Room,
    requested: boolean,
  ): { eliminatedHands?: FourShogiEliminatedHands | null } {
    if (!requested || !isFourShogiRoom(room)) return {};
    const roundId = room.status === "playing" ? room.roundId : room.lastRound?.roundId;
    if (!roundId) return { eliminatedHands: null };
    const stored = this.storage.kv.get<FourShogiEliminatedHands>(shogiEliminatedHandsKey);
    return { eliminatedHands: stored?.roundId === roundId ? stored : { roundId, hands: {} } };
  }

  isEliminated(room: FourShogiRoom, playerId: string): boolean {
    if (room.status !== "playing") return false;
    const player = room.players.find((p) => p.id === playerId);
    return !!player && room.game.eliminations.some((e) => e.side === player.side);
  }
  play(
    room: FourShogiRoom,
    tokenHash: string,
    command: GameActionCommandFor<"four-shogi">,
  ): Result {
    return this.command(room, tokenHash, command.action, command);
  }
  draw(
    room: FourShogiRoom,
    tokenHash: string,
    command: Extract<RoomSocketClientMessage, { type: "room.game.draw.set" }>,
  ): Result {
    if (room.tournamentId !== undefined) return { kind: "rejected", error: "forbidden" };
    return this.command(
      room,
      tokenHash,
      { type: "drawProposal", proposed: command.proposed },
      command,
    );
  }

  private checkCommand(
    room: FourShogiRoom,
    tokenHash: string,
    operation: "play" | "resign",
    command?: { roundId: string; positionRevision: number },
    action?: FourShogiGameAction,
  ) {
    const membership = this.membership(tokenHash);
    const player = room.players.find((p) => p.id === membership?.playerId);
    const error = checkGameCommand({
      operation,
      status: room.status,
      hasLastRound: room.lastRound !== null,
      seat: player?.side ?? null,
      eliminatedSeats: room.game?.eliminations.map((e) => e.side) ?? [],
      turn: room.game ? definition.rules.getTurn({ ...room.game, repetitions: {} }) : null,
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
    room: FourShogiRoom,
    tokenHash: string,
    action: FourShogiGameAction,
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
        error: action.type === "drawProposal" ? "invalid_request" : "invalid_move",
      };
    if (result.state === state) return { kind: "unchanged", gameId: "four-shogi", room };
    return this.accept(
      room,
      result.state,
      result.event,
      Date.now(),
      definition.rules.endsTurn?.(action) ?? true,
    );
  }
  resign(room: FourShogiRoom, tokenHash: string): Result {
    const { error, player } = this.checkCommand(room, tokenHash, "resign");
    if (error) return { kind: "rejected", error };
    if (room.status !== "playing" || !player) throw new Error("Expected playing seat");
    return this.eliminate(room, player.id, "resigned", Date.now());
  }
  start(
    room: WaitingFor<"four-shogi">,
    tournament?: TournamentRoomContext,
    rating?: FourShogiRatingSource,
  ) {
    return startFourShogiRound(
      this.storage,
      this.store(),
      this.accountId,
      room,
      tournament,
      rating,
    );
  }

  accept(
    room: Extract<FourShogiRoom, { status: "playing" }>,
    state: FourShogiState,
    event: FourShogiReplayEvent,
    at: number,
    turnEnded: boolean,
  ): Result {
    const core = saveFourShogiTransition(this.storage, this.store(), room, state, event);
    this.storage.kv.delete(shogiCpuJobKey);
    this.storage.kv.delete(fourShogiAiJobKey);
    if (state.status === "finished") {
      if (core.status !== "finished") throw new Error("Expected finished Shogi state");
      return { kind: "finished", gameId: "four-shogi", room, game: core, at };
    }
    const updated = fourShogiRoomSchema.parse({
      ...room,
      game: core,
      eliminations: state.eliminations,
      positionRevision: room.positionRevision + 1,
      ...getActionAvailability(state),
      checkState: getCheckState(state),
      clock: advanceShogiClock(
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
    return { kind: "playing", gameId: "four-shogi", room: updated };
  }
  finalize(result: FinishedProgress<"four-shogi">) {
    return finalizeFourShogiRound(this.storage, this.store(), result);
  }

  eliminate(
    room: Extract<FourShogiRoom, { status: "playing" }>,
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
        gameId: "four-shogi",
        room: fourShogiRoomSchema.parse({ ...room, players }),
      };
    const { state, repetitionLookup } = this.store().loadTransition(room.roundId, room.game);
    const result = definition.rules.eliminateSeat(state, player.side, reason, repetitionLookup);
    const input = fourShogiRoomSchema.parse({ ...room, players });
    if (input.status !== "playing") throw new Error("Expected playing room");
    return this.accept(input, result.state, result.event, at, result.state.turn !== room.game.turn);
  }

  cpuDraw(room: Playing, now: number): Result {
    const result = this.cpuProgress.cpuDraw(room);
    return result
      ? this.accept(room, result.state, result.event, now, false)
      : { kind: "unchanged", gameId: "four-shogi", room };
  }

  externalCpuJob(room: Playing) {
    return this.cpuProgress.externalCpuJob(room);
  }

  prepareExternalCpu(
    room: Playing,
    now: number,
    timeout: number,
    unavailable: "configuration" | "capacity_unavailable" | null,
  ) {
    return this.cpuProgress.prepareExternalCpu(room, now, timeout, unavailable);
  }

  completeExternalCpu(
    room: Playing,
    job: FourShogiAiWork["job"],
    response: FourShogiCpuResponse,
    now: number,
  ) {
    this.cpuProgress.completeExternalCpu(room, job, response, now);
  }

  cpu(room: Playing, now: number): Result {
    const result = this.cpuProgress.cpu(room, now);
    return result
      ? this.accept(room, result.state, result.event, now, true)
      : { kind: "unchanged", gameId: "four-shogi", room };
  }

  waiting(data: RematchFor<"four-shogi">, players: FourShogiRoom["players"]) {
    return waitingFourShogiRoom(data, players);
  }

  migrateLegacy(room: FourShogiRoom, saved: object): void {
    migrateLegacyFourShogiRoom(room, saved);
  }

  settings(room: WaitingFor<"four-shogi">, prohibited: boolean): WaitingFor<"four-shogi"> {
    const updated = fourShogiRoomSchema.parse({
      ...room,
      settings: { ...room.settings, threePlayerAttackProhibited: prohibited },
      players: room.players.map((p) => (p.kind === "human" ? { ...p, ready: false } : p)),
      lastActivityAtMs: Date.now(),
      publicUpdatedAtMs: nextPublicUpdateAt(room),
    });
    if (updated.status !== "waiting") throw new Error("Expected waiting room");
    return updated;
  }
}
