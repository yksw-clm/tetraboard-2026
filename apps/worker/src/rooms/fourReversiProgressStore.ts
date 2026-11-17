import { savedProfileRatings } from "../accounts/profileRatings";
import { fourReversiRatingMethod } from "@tetraboard/context-rating";
import type { FourReversiRatingSource } from "../matchmaking/fourReversiSelection";
import {
  activeTournamentContextKey,
  type TournamentRoomContext,
} from "@tetraboard/context-tournament";
import {
  fourReversiRoomSchema,
  roundReplaySchema,
  type FourReversiRoom,
  type LastRound,
  type RoundReplay,
} from "@tetraboard/protocol";
import {
  fourReversiDefinition as definition,
  type FourReversiEvent,
} from "@tetraboard/four-reversi/definition";
import type { FourReversiState } from "@tetraboard/four-reversi";
import { createClock } from "./clock";
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
} from "./progressHelpers";
import type { ProgressDependencies, PlayingFor, WaitingFor } from "./gameProgress";
import { fourReversiCpuJobKey, fourReversiAiJobKey } from "./fourReversiCpu";
type Playing = PlayingFor<"four-reversi">;
const colors = definition.catalog.seats;

export function startFourReversiRound(
  storage: DurableObjectStorage,
  room: WaitingFor<"four-reversi">,
  accountId: ProgressDependencies["accountId"],
  tournament?: TournamentRoomContext,
  rating?: FourReversiRatingSource,
): { room: Playing; roundId: string; at: number } {
  storage.kv.delete(fourReversiCpuJobKey);
  storage.kv.delete(fourReversiAiJobKey);
  const assignments = shuffledAssignments(colors);
  const startedAtMs = Date.now();
  const matchId = tournament?.matchId ?? room.matchmaking?.id ?? crypto.randomUUID();
  if (tournament) storage.kv.put(activeTournamentContextKey, tournament);
  else storage.kv.delete(activeTournamentContextKey);
  const { tournamentStartsAtMs: _countdown, ...waiting } = room;
  const startedRoom = fourReversiRoomSchema.parse({
    ...waiting,
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
    game: definition.rules.createInitialState(room.settings),
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
  saveMatchStart(storage, startedRoom, accountId, matchId, startedAtMs, rating);
  return { room: startedRoom, roundId: matchId, at: startedAtMs };
}

function saveMatchStart(
  storage: DurableObjectStorage,
  room: Playing,
  accountId: ProgressDependencies["accountId"],
  id: string,
  startedAtMs: number,
  rating?: FourReversiRatingSource,
) {
  storage.kv.put(matchStartKey, {
    ...savedProfileRatings(storage, id),
    id,
    roomId: room.id,
    instanceId: room.instanceId,
    startedAtMs,
    settings: room.settings,
    ...(rating
      ? {
          fourReversiRating: {
            method: fourReversiRatingMethod,
            calibrationVersion: rating.calibrationVersion,
            cpu: Object.fromEntries(
              room.players.flatMap((player) =>
                player.kind === "cpu" && rating.cpu ? [[player.color, rating.cpu]] : [],
              ),
            ),
          },
        }
      : {}),
    participants: room.players.map((player, seat) => ({
      id: player.id,
      name: playerLabel(player),
      color: player.color,
      seat,
      ...(player.kind === "cpu"
        ? {
            kind: "cpu" as const,
            level: player.level,
            ...(player.cpuProfile ? { cpuProfile: player.cpuProfile } : {}),
          }
        : {
            kind: "human" as const,
            accountId: accountId(player.id),
          }),
    })),
  } satisfies MatchStart);
}

export function recordFourReversiTransition(
  storage: DurableObjectStorage,
  room: Playing,
  result: { state: FourReversiState; event: FourReversiEvent },
): void {
  const { passedColors, ...action } = result.event;
  if (action.type === "eliminate")
    room.eliminations.push({ color: action.color, reason: action.reason });
  const saved = storage.kv.get(replayKey);
  // 記録導入前に開始した対局の棋譜は、途中から補完しません。
  if (saved === undefined) return;
  const replay = roundReplaySchema.parse(saved);
  replay.steps.push(
    roundReplaySchema.shape.steps.element.parse({ action, game: result.state, passedColors }),
  );
  storage.kv.put(replayKey, replay);
}

export function finalizeFourReversiRound(
  storage: DurableObjectStorage,
  room: Extract<FourReversiRoom, { status: "playing" }>,
  game: LastRound["game"],
  at: number,
): LastRound {
  storage.kv.delete(fourReversiCpuJobKey);
  storage.kv.delete(fourReversiAiJobKey);
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
    game,
    replay: storage.kv.get<RoundReplay>(replayKey) ?? null,
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
