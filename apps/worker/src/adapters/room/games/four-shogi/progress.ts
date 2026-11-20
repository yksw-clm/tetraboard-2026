import { migrateLegacyFourShogiRoom } from "../../legacyRoomMigrations";
import {
  fourShogiRoomSchema,
  isFourShogiRoom,
  type FourShogiRoom,
  type FourShogiReplayEvent,
  type Room,
  type FourShogiEliminatedHands,
  type RoomSocketClientMessage,
} from "@tetraboard/protocol";
import { getActionAvailability, getCheckState, type FourShogiState } from "@tetraboard/four-shogi";
import {
  fourShogiDefinition as definition,
  type FourShogiTypes,
} from "@tetraboard/four-shogi/definition";
import { createGameProgress, type GameProgressSpec } from "@tetraboard/context-room";
import { ShogiStore } from "./store";
import type { TournamentRoomContext } from "@tetraboard/context-tournament";
import type { FourShogiRatingSource } from "@tetraboard/context-matchmaking";
import { advanceShogiClock } from "../../shogiClock";
import { isClockExpired } from "../../clock";
import { shogiCpuJobKey, nextPublicUpdateAt } from "../progressHelpers";
import type { ProgressDependencies, ProgressFor, PlayingFor, WaitingFor } from "../gameProgress";
import {
  FourShogiCpu,
  fourShogiAiJobKey,
  type FourShogiAiWork,
  type FourShogiCpuResponse,
} from "./cpu";
import { fourShogiProgressStore } from "./progressStore";
import { shogiEliminatedHandsKey } from "./progressRecords";
export { shogiEliminatedHandsKey } from "./progressRecords";
export { fourShogiAiJobKey, type FourShogiAiWork, type ShogiCpuJob } from "./cpu";
export const eliminatedHandsTag = "eliminated-hands-v1";
type Playing = PlayingFor<"four-shogi">;
type Result = ProgressFor<"four-shogi">;
export class FourShogiProgress {
  private readonly storage: DurableObjectStorage;
  readonly start;
  readonly play;
  readonly resign;
  readonly eliminate;
  readonly isEliminated;
  readonly finalize;
  readonly waiting;
  private readonly command;
  private readonly acceptTransition;
  private readonly cpuProgress: FourShogiCpu;
  private shogiStore: ShogiStore | null = null;

  constructor({ storage, membership, accountId }: ProgressDependencies) {
    this.storage = storage;
    this.cpuProgress = new FourShogiCpu(storage, () => this.store());
    const spec: GameProgressSpec<
      "four-shogi",
      FourShogiTypes,
      [tournament?: TournamentRoomContext, rating?: FourShogiRatingSource]
    > = {
      gameId: "four-shogi",
      definition,
      parseRoom: (room) => fourShogiRoomSchema.parse(room),
      parseFinishedState: (_state, saved) => {
        if (!saved || saved.status !== "finished") throw new Error("Expected finished Shogi state");
        return saved;
      },
      stateFromRoom: (game) => ({ ...game, repetitions: {} }),
      seat: (player) => player.side,
      inactiveSeats: (game) => game.eliminations.map((e) => e.side),
      waitingSeat: { side: null },
      unknownPlayerMessage: "Unknown Shogi player",
      useActionRules: true,
      toAction: (command) => command.action,
      moveError: (_reason, action) =>
        action.type === "drawProposal" ? "invalid_request" : "invalid_move",
      prepareLeaveResult: ({ state }) => ({ ok: true, state }),
      updatePlayersOnElimination: true,
      clearCpuJobsOnAccept: () => {
        storage.kv.delete(shogiCpuJobKey);
        storage.kv.delete(fourShogiAiJobKey);
      },
      playingFields: (state) => ({
        eliminations: [...state.eliminations],
        ...getActionAvailability(state),
        checkState: getCheckState(state),
      }),
      waitingFields: {
        legalActions: [],
        threePlayerAttackForbiddenActions: [],
        checkState: { south: false, west: false, north: false, east: false },
      },
      advanceClock: advanceShogiClock,
      isClockExpired,
      store: fourShogiProgressStore(storage, () => this.store()),
      membership,
      accountId,
      now: () => Date.now(),
    };
    const progress = createGameProgress(spec);
    this.start = progress.start.bind(progress);
    this.play = progress.play.bind(progress);
    this.resign = progress.resign.bind(progress);
    this.eliminate = progress.eliminate.bind(progress);
    this.isEliminated = progress.isEliminated.bind(progress);
    this.finalize = progress.finalize.bind(progress);
    this.waiting = progress.waiting.bind(progress);
    this.command = progress.command.bind(progress);
    this.acceptTransition = progress.acceptTransition.bind(progress);
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

  accept(
    room: Playing,
    state: FourShogiState,
    event: FourShogiReplayEvent,
    at: number,
    turnEnded: boolean,
  ): Result {
    return this.acceptTransition(room, { state, event }, at, turnEnded);
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
