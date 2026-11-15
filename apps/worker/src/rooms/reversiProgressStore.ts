import { savedProfileRatings } from "../accounts/profileRatings";
import type { GameTransition } from "@tetraboard/game-contract";
import type { ReversiState } from "@tetraboard/reversi";
import type { ReversiEvent } from "@tetraboard/reversi/definition";
import {
  reversiRoomSchema,
  reversiReplaySchema as roundReplaySchema,
  type ReversiLastRound as LastRound,
  type ReversiReplay as RoundReplay,
} from "@tetraboard/protocol";
import { gameDefinitions } from "./gameDefinitions";
import type { PlayingFor, WaitingFor, ProgressDependencies } from "./gameProgress";
import {
  matchStartKey,
  pendingMatchPrefix,
  type MatchStart,
  type PendingMatch,
} from "./reversiMatchStore";
import {
  roomStorageKey,
  replayKey,
  playerLabel,
  playerAppearance,
  nextPublicUpdateAt,
  shuffledAssignments,
} from "./progressHelpers";
import { createClock } from "./reversiClock";
import type { EloRatingSource } from "./eloRating";

type Playing = PlayingFor<"reversi">;
export const externalCpuJobKey = "reversi-external-cpu-job";

export function startReversiRound(
  storage: DurableObjectStorage,
  room: WaitingFor<"reversi">,
  accountId: ProgressDependencies["accountId"],
  rating?: EloRatingSource,
): { room: Playing; roundId: string; at: number } {
  const assignments = shuffledAssignments(gameDefinitions.reversi.catalog.seats);
  const startedAtMs = Date.now();
  const matchId = room.matchmaking?.id ?? crypto.randomUUID();
  const startedRoom = reversiRoomSchema.parse({
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
    game: gameDefinitions.reversi.rules.createInitialState({}),
    clock: createClock(startedAtMs, room.settings.timeControl),
  });
  storage.kv.delete(externalCpuJobKey);
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
  saveMatchStart(storage, startedRoom, matchId, startedAtMs, accountId, rating);
  return { room: startedRoom, roundId: matchId, at: startedAtMs };
}

function saveMatchStart(
  storage: DurableObjectStorage,
  room: Playing,
  matchId: string,
  startedAtMs: number,
  accountId: ProgressDependencies["accountId"],
  rating?: EloRatingSource,
): void {
  storage.kv.put(matchStartKey, {
    ...savedProfileRatings(storage, matchId),
    id: matchId,
    roomId: room.id,
    instanceId: room.instanceId,
    startedAtMs,
    settings: room.settings,
    ...(rating ? { rating } : {}),
    participants: room.players.map((player, seat) => ({
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

export function recordReversiTransition(
  storage: DurableObjectStorage,
  room: Playing,
  { state, event }: GameTransition<ReversiState, ReversiEvent>,
): void {
  // 呼び出し元のトランザクションで、理由を盤面・棋譜と一緒に保存します。
  const { passedColors, ...action } = event;
  if (action.type === "eliminate")
    room.eliminations.push({ color: action.color, reason: action.reason });
  const saved = storage.kv.get(replayKey);
  // 記録導入前に開始した対局の棋譜は、途中から補完しません。
  if (saved === undefined) return;
  const replay = roundReplaySchema.parse(saved);
  replay.steps.push(
    roundReplaySchema.shape.steps.element.parse({ action, game: state, passedColors }),
  );
  storage.kv.put(replayKey, replay);
}

export function finalizeReversiRound(
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
      retryAtMs: Date.now(),
    } satisfies PendingMatch);
  }
  storage.kv.delete(matchStartKey);
  storage.kv.delete(externalCpuJobKey);
  const lastRound: LastRound = {
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
