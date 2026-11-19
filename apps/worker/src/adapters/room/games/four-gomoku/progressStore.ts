import type { GameProgressStore } from "@tetraboard/context-room";
import {
  activeTournamentContextKey,
  type TournamentRoomContext,
} from "@tetraboard/context-tournament";
import type { GameTransition } from "@tetraboard/game-contract";
import type { Color, FourGomokuState, Position } from "@tetraboard/four-gomoku";
import type { FourGomokuEvent, FourGomokuTypes } from "@tetraboard/four-gomoku/definition";
import {
  fourGomokuRoomSchema,
  fourGomokuReplaySchema as roundReplaySchema,
  type FourGomokuLastRound as LastRound,
  type FourGomokuReplay as RoundReplay,
} from "@tetraboard/protocol";
import { gameDefinitions } from "../gameDefinitions";
import type { PlayingFor, ProgressDependencies, WaitingFor } from "../gameProgress";
import {
  matchStartKey,
  pendingMatchPrefix,
  type MatchStart,
  type PendingMatch,
} from "../../../record/fourGomokuMatchStore";
import {
  nextPublicUpdateAt,
  playerAppearance,
  playerLabel,
  replayKey,
  roomStorageKey,
  shuffledAssignments,
} from "../progressHelpers";
import { createClock } from "../../clock";

type Playing = PlayingFor<"four-gomoku">;
export type FourGomokuStartArgs = [tournament?: TournamentRoomContext];

export const fourGomokuCpuJobKey = "four-gomoku-cpu-job";
export type FourGomokuCpuJob = {
  roundId: string;
  positionRevision: number;
  color: Color;
  move: Position;
  applyAt: number;
};

export function fourGomokuProgressStore(
  storage: DurableObjectStorage,
): GameProgressStore<"four-gomoku", FourGomokuTypes, FourGomokuStartArgs> {
  return {
    start: (room, accountId, tournament) =>
      startFourGomokuRound(storage, room, accountId, tournament),
    recordTransition: (room, transition) => recordFourGomokuTransition(storage, room, transition),
    finalize: ({ room, game, at }) => finalizeFourGomokuRound(storage, room, game, at),
    readCpuJob: () => {
      const job = storage.kv.get<FourGomokuCpuJob>(fourGomokuCpuJobKey);
      if (!job) return undefined;
      return {
        roundId: job.roundId,
        positionRevision: job.positionRevision,
        seat: job.color,
        action: { type: "placeStone", position: job.move },
        applyAt: job.applyAt,
      };
    },
    writeCpuJob: (job) => {
      storage.kv.put(fourGomokuCpuJobKey, {
        roundId: job.roundId,
        positionRevision: job.positionRevision,
        color: job.seat,
        move: job.action.position,
        applyAt: job.applyAt,
      } satisfies FourGomokuCpuJob);
    },
    deleteCpuJob: () => {
      storage.kv.delete(fourGomokuCpuJobKey);
    },
  };
}

export function startFourGomokuRound(
  storage: DurableObjectStorage,
  room: WaitingFor<"four-gomoku">,
  accountId: ProgressDependencies["accountId"],
  tournament?: TournamentRoomContext,
): { room: Playing; roundId: string; at: number } {
  const assignments = shuffledAssignments(gameDefinitions["four-gomoku"].catalog.seats);
  const startedAtMs = Date.now();
  const matchId = tournament?.matchId ?? crypto.randomUUID();
  if (tournament) storage.kv.put(activeTournamentContextKey, tournament);
  else storage.kv.delete(activeTournamentContextKey);
  const { tournamentStartsAtMs: _countdown, ...waiting } = room;
  const startedRoom = fourGomokuRoomSchema.parse({
    ...waiting,
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
    game: gameDefinitions["four-gomoku"].rules.createInitialState(room.settings),
    clock: createClock(startedAtMs, room.settings.timeControl),
  });
  storage.kv.put(roomStorageKey, startedRoom);
  storage.kv.put(
    replayKey,
    roundReplaySchema.parse({
      id: matchId,
      initial: startedRoom.game,
      steps: [],
    }),
  );
  if (startedRoom.status !== "playing") throw new Error("Game did not start");
  saveMatchStart(storage, startedRoom, startedAtMs, accountId);
  return { room: startedRoom, roundId: matchId, at: startedAtMs };
}

function saveMatchStart(
  storage: DurableObjectStorage,
  startedRoom: Playing,
  startedAtMs: number,
  accountId: ProgressDependencies["accountId"],
): void {
  storage.kv.put(matchStartKey, {
    id: startedRoom.roundId,
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
            accountId: accountId(player.id),
          }),
    })),
  } satisfies MatchStart);
}

export function recordFourGomokuTransition(
  storage: DurableObjectStorage,
  room: Playing,
  { state, event }: GameTransition<FourGomokuState, FourGomokuEvent>,
): void {
  // 呼び出し元のトランザクションで、理由を盤面・棋譜と一緒に保存します。
  if (event.type === "eliminate")
    room.eliminations.push({ color: event.color, reason: event.reason });
  const saved = storage.kv.get(replayKey);
  if (saved === undefined) throw new Error("Missing FourGomoku replay");
  const replay = roundReplaySchema.parse(saved);
  replay.steps.push(roundReplaySchema.shape.steps.element.parse({ action: event, game: state }));
  storage.kv.put(replayKey, replay);
}

export function finalizeFourGomokuRound(
  storage: DurableObjectStorage,
  room: Playing,
  game: LastRound["game"],
  at: number,
): LastRound {
  const start = storage.kv.get<MatchStart>(matchStartKey);
  const replay = storage.kv.get<RoundReplay>(replayKey);
  if (start && replay && start.id === replay.id) {
    storage.kv.put(`${pendingMatchPrefix}${start.id}`, {
      record: { ...start, endedAtMs: at, game, eliminations: room.eliminations, replay },
      tournament: storage.kv.get<TournamentRoomContext>(activeTournamentContextKey),
      retryAtMs: Date.now(),
    } satisfies PendingMatch);
  }
  storage.kv.delete(matchStartKey);
  storage.kv.delete(activeTournamentContextKey);
  const lastRound: LastRound = {
    settings: room.settings,
    game,
    replay: roundReplaySchema.parse(storage.kv.get<RoundReplay>(replayKey)),
    players: room.players.map((player) => ({
      id: player.id,
      name: playerLabel(player),
      color: player.color,
      appearance: playerAppearance(player),
    })),
  };
  storage.kv.delete(replayKey);
  return lastRound;
}
