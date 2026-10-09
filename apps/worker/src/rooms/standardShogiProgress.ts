import {
  shogiRoomSchema,
  isShogiRoom,
  type ShogiRoom,
  type ShogiLastRound,
  type ShogiReplayEvent,
  type RoomSocketClientMessage,
  type GameActionCommandFor,
} from "@tetraboard/protocol";
import {
  applyAction as applyShogiAction,
  chooseCpuAction,
  createInitialState as createShogiState,
  eliminateSide,
  setDrawProposal,
  getActionAvailability,
  getCheckState,
  sides,
  type Side,
  type ShogiAction,
  type ShogiState,
  type ExternalEliminationReason,
} from "@tetraboard/shogi";
import { StandardShogiStore } from "./standardShogiStore";
import {
  standardShogiMatchStartKey as shogiMatchStartKey,
  pendingStandardShogiMatchPrefix as pendingShogiMatchPrefix,
  type StandardShogiMatchRecord,
  type PendingStandardShogiMatch,
} from "./shogiMatchStore";
import { initializeClock, advanceTurnClock } from "./clockCore";
import { declarationStatus, declareEnteringKing, canProposeImpasse } from "@tetraboard/shogi";
import { isClockExpired } from "./clock";
import {
  roomStorageKey,
  playerLabel,
  playerAppearance,
  nextPublicUpdateAt,
  shuffledAssignments,
} from "./progressHelpers";
import type {
  ProgressDependencies,
  ProgressFor,
  PlayingFor,
  WaitingFor,
  FinishedProgress,
  RematchFor,
} from "./gameProgress";
const shogiCpuJobKey = "standard-shogi-cpu-job";
type ActiveShogiMatch = { start: Omit<StandardShogiMatchRecord, "endedAtMs" | "game" | "replay"> };
type Playing = PlayingFor<"shogi">;
type Result = ProgressFor<"shogi">;
export type ShogiCpuJob = {
  roundId: string;
  positionRevision: number;
  side: Side;
  action: ShogiAction | "declaration";
  applyAt: number;
};
export class ShogiProgress {
  private readonly storage: DurableObjectStorage;
  private readonly membership: ProgressDependencies["membership"];
  private readonly accountId: ProgressDependencies["accountId"];
  private shogiStore: StandardShogiStore | null = null;
  constructor(dependencies: ProgressDependencies) {
    this.storage = dependencies.storage;
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
    const { action, roundId, positionRevision } = command;
    if (room.status !== "playing")
      return { kind: "rejected", error: room.lastRound ? "game_finished" : "game_not_started" };
    const membership = this.membership(tokenHash);
    if (!membership) return { kind: "rejected", error: "unauthorized" };
    const player = room.players.find((p) => p.id === membership.playerId);
    if (!player) return { kind: "rejected", error: "unauthorized" };
    if (roundId !== room.roundId || positionRevision !== room.positionRevision)
      return { kind: "rejected", error: "stale_position" };
    if (isClockExpired(room.clock, Date.now())) return { kind: "rejected", error: "time_expired" };
    if (this.isEliminated(room, player.id))
      return { kind: "rejected", error: "already_eliminated" };
    if (player.side !== room.game.turn) return { kind: "rejected", error: "not_your_turn" };
    const { state, repetitionLookup } = this.store().loadTransition(room.roundId, room.game);
    const result = applyShogiAction(state, player.side, action, repetitionLookup);
    if (!result.ok) return { kind: "rejected", error: "invalid_move" };
    return this.accept(
      room,
      result.state,
      { type: "action", side: player.side, action },
      Date.now(),
      true,
    );
  }

  resign(room: ShogiRoom, tokenHash: string): Result {
    if (room.status !== "playing")
      return { kind: "rejected", error: room.lastRound ? "game_finished" : "game_not_started" };
    if (isClockExpired(room.clock, Date.now())) return { kind: "rejected", error: "time_expired" };
    const membership = this.membership(tokenHash);
    const player = room.players.find((p) => p.id === membership?.playerId);
    if (!player) return { kind: "rejected", error: "unauthorized" };
    if (this.isEliminated(room, player.id))
      return { kind: "rejected", error: "already_eliminated" };
    if (player.side !== room.game.turn) return { kind: "rejected", error: "not_your_turn" };
    return this.eliminate(room, player.id, "resigned", Date.now());
  }

  draw(
    room: ShogiRoom,
    tokenHash: string,
    command: Extract<RoomSocketClientMessage, { type: "room.game.draw.set" }>,
  ): Result {
    if (room.status !== "playing")
      return { kind: "rejected", error: room.lastRound ? "game_finished" : "game_not_started" };
    const membership = this.membership(tokenHash);
    const player = room.players.find((entry) => entry.id === membership?.playerId);
    if (!player) return { kind: "rejected", error: "unauthorized" };
    if (command.roundId !== room.roundId || command.positionRevision !== room.positionRevision)
      return { kind: "rejected", error: "stale_position" };
    const at = Date.now();
    if (isClockExpired(room.clock, at)) return { kind: "rejected", error: "time_expired" };
    const { state } = this.store().loadTransition(room.roundId, room.game);
    const result = setDrawProposal(state, player.side, command.proposed);
    if (!result.ok)
      return {
        kind: "rejected",
        error: "invalid_request",
      };
    if (result.state === state) return { kind: "unchanged", gameId: "shogi", room };
    return this.accept(
      room,
      result.state,
      { type: "drawProposal", side: player.side, proposed: command.proposed },
      at,
      false,
    );
  }

  declare(
    room: ShogiRoom,
    tokenHash: string,
    command: Extract<RoomSocketClientMessage, { type: "room.game.declare" }>,
  ): Result {
    if (room.status !== "playing")
      return { kind: "rejected", error: room.lastRound ? "game_finished" : "game_not_started" };
    const player = room.players.find((p) => p.id === this.membership(tokenHash)?.playerId);
    if (!player) return { kind: "rejected", error: "unauthorized" };
    if (command.roundId !== room.roundId || command.positionRevision !== room.positionRevision)
      return { kind: "rejected", error: "stale_position" };
    const at = Date.now();
    if (isClockExpired(room.clock, at)) return { kind: "rejected", error: "time_expired" };
    if (player.side !== room.game.turn) return { kind: "rejected", error: "not_your_turn" };
    const { state } = this.store().loadTransition(room.roundId, room.game);
    const result = declareEnteringKing(state, player.side);
    if (!result.ok) return { kind: "rejected", error: "invalid_request" };
    return this.accept(room, result.state, { type: "declaration", side: player.side }, at, false);
  }

  start(room: Extract<ShogiRoom, { status: "waiting" }>): {
    room: Playing;
    roundId: string;
    at: number;
  } {
    const assignments = shuffledAssignments(sides);
    const players = room.players.map((player, index) => ({
      ...player,
      side: assignments[index],
      ready: player.kind === "cpu",
    }));
    const seatId = (side: Side): string => {
      const player = players.find((p) => p.side === side);
      if (!player) throw new Error("Missing assigned Shogi seat");
      return player.id;
    };
    const initial = {
      players: {
        south: seatId("south"),
        north: seatId("north"),
      },
    };
    const state = createShogiState(initial);
    const roundId = crypto.randomUUID();
    const at = Date.now();
    this.store().startReplay(roundId, initial);
    this.storage.kv.delete(shogiCpuJobKey);
    const started = shogiRoomSchema.parse({
      ...room,
      status: "playing",
      lastRound: null,
      players,
      roundId,
      positionRevision: 0,
      game: this.store().saveState(roundId, state),
      ...getActionAvailability(state),
      checkState: getCheckState(state),
      eliminations: [],
      clock: initializeClock(
        {
          south: room.settings.timeControl.mainTimeMs,
          north: room.settings.timeControl.mainTimeMs,
        },
        at,
        room.settings.timeControl,
      ),
      publicUpdatedAtMs: nextPublicUpdateAt(room),
      lastActivityAtMs: at,
    });
    if (!isShogiRoom(started) || started.status !== "playing")
      throw new Error("Shogi game did not start");
    this.storage.kv.put(roomStorageKey, started);
    this.storage.kv.put(shogiMatchStartKey, {
      start: {
        id: roundId,
        roomId: room.id,
        instanceId: room.instanceId,
        startedAtMs: at,
        settings: room.settings,
        participants: started.players.map((player, seat) => ({
          id: player.id,
          name: playerLabel(player),
          side: player.side,
          seat,
          ...(player.kind === "cpu"
            ? { kind: "cpu" as const, level: player.level }
            : {
                kind: "human" as const,
                accountId: this.accountId(player.id),
              }),
        })),
      },
    } satisfies ActiveShogiMatch);
    return { room: started, roundId, at };
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

  finalize(result: FinishedProgress<"shogi">): ShogiLastRound {
    const { room, game: core, at } = result;
    const active = this.storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey);
    if (active?.start.id === room.roundId) {
      this.store().protectArchive(room.roundId);
      this.storage.kv.put(pendingShogiMatchPrefix + room.roundId, {
        record: {
          ...active.start,
          endedAtMs: at,
          game: core,
          replay: {
            rulesVersion: 1,
            initial: this.store().replayInfo(room.roundId),
            eventCount: this.store().eventCount(room.roundId),
          },
        },
        progress: { phase: "upload", cursor: 0 },
        retryAtMs: Date.now(),
      } satisfies PendingStandardShogiMatch);
    }
    this.storage.kv.delete(shogiMatchStartKey);
    const lastRound: ShogiLastRound = {
      roundId: room.roundId,
      game: core,
      players: room.players.map((player) => ({
        id: player.id,
        name: playerLabel(player),
        side: player.side,
        appearance: playerAppearance(player),
      })),
      eventCount: this.store().eventCount(room.roundId),
    };
    return lastRound;
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
    const result = eliminateSide(state, player.side, reason);
    if (!result.ok) throw new Error(`Could not eliminate Shogi player: ${result.reason}`);
    const input = shogiRoomSchema.parse({ ...room, players });
    if (input.status !== "playing") throw new Error("Expected playing room");
    return this.accept(
      input,
      result.state,
      { type: "eliminate", side: player.side, reason },
      at,
      result.state.turn !== room.game.turn,
    );
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
    const result = setDrawProposal(state, cpu.side, proposed);
    if (!result.ok) throw new Error("Could not update CPU draw proposal");
    return this.accept(
      room,
      result.state,
      { type: "drawProposal", side: cpu.side, proposed },
      now,
      false,
    );
  }

  cpu(room: Playing, now: number): Result {
    const cpu = room.players.find((p) => p.side === room.game.turn);
    if (cpu?.kind !== "cpu") return { kind: "unchanged", gameId: "shogi", room };
    const job = this.storage.kv.get<ShogiCpuJob>(shogiCpuJobKey);
    if (job) {
      if (
        job.roundId !== room.roundId ||
        job.positionRevision !== room.positionRevision ||
        job.side !== room.game.turn
      )
        this.storage.kv.delete(shogiCpuJobKey);
      else if (job.applyAt <= now) {
        const { state, repetitionLookup } = this.store().loadTransition(room.roundId, room.game);
        const result =
          job.action === "declaration"
            ? declareEnteringKing(state, job.side)
            : applyShogiAction(state, job.side, job.action, repetitionLookup);
        if (!result.ok) throw new Error("Saved CPU action is no longer legal");
        return this.accept(
          room,
          result.state,
          job.action === "declaration"
            ? { type: "declaration", side: job.side }
            : { type: "action", side: job.side, action: job.action },
          now,
          true,
        );
      }
    } else {
      const { state, repetitionLookup } = this.store().loadTransition(room.roundId, room.game);
      const status = declarationStatus(state, cpu.side);
      const action =
        status.eligible && status.outcome === "win"
          ? "declaration"
          : chooseCpuAction(state, cpu.level, Math.random, repetitionLookup);
      if (!action) throw new Error("Shogi CPU has no legal action");
      this.storage.kv.put(shogiCpuJobKey, {
        roundId: room.roundId,
        positionRevision: room.positionRevision,
        side: room.game.turn,
        action,
        applyAt: Date.now() + 1,
      } satisfies ShogiCpuJob);
    }
    return { kind: "unchanged", gameId: "shogi", room };
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
