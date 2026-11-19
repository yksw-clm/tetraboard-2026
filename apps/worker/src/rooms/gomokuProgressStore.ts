import type { GameTransition } from "@tetraboard/game-contract";
import type { GomokuState } from "@tetraboard/gomoku";
import type { GomokuEvent } from "@tetraboard/gomoku/definition";
import {
  gomokuRoomSchema,
  gomokuReplaySchema as roundReplaySchema,
  type GomokuLastRound as LastRound,
  type GomokuReplay as RoundReplay,
} from "@tetraboard/protocol";
import { gameDefinitions } from "./gameDefinitions";
import type { PlayingFor, ProgressDependencies, WaitingFor } from "./gameProgress";
import {
  matchStartKey,
  pendingMatchPrefix,
  type MatchStart,
  type PendingMatch,
} from "../adapters/record/gomokuMatchStore";
import {
  nextPublicUpdateAt,
  playerAppearance,
  playerLabel,
  replayKey,
  roomStorageKey,
  shuffledAssignments,
} from "./progressHelpers";
import { createClock } from "./reversiClock";

type Playing = PlayingFor<"gomoku">;

export function startGomokuRound(
  storage: DurableObjectStorage,
  room: WaitingFor<"gomoku">,
  accountId: ProgressDependencies["accountId"],
): { room: Playing; roundId: string; at: number } {
  const assignments = shuffledAssignments(gameDefinitions.gomoku.catalog.seats);
  const startedAtMs = Date.now();
  const matchId = crypto.randomUUID();
  const startedRoom = gomokuRoomSchema.parse({
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
    game: gameDefinitions.gomoku.rules.createInitialState(room.settings),
    clock: createClock(startedAtMs, room.settings.timeControl),
  });
  storage.kv.put(roomStorageKey, startedRoom);
  storage.kv.put(
    replayKey,
    roundReplaySchema.parse({ id: matchId, initial: startedRoom.game, steps: [] }),
  );
  if (startedRoom.status !== "playing") throw new Error("Game did not start");
  storage.kv.put(matchStartKey, {
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
        : { kind: "human" as const, accountId: accountId(player.id) }),
    })),
  } satisfies MatchStart);
  return { room: startedRoom, roundId: matchId, at: startedAtMs };
}

export function recordGomokuTransition(
  storage: DurableObjectStorage,
  room: Playing,
  { state, event }: GameTransition<GomokuState, GomokuEvent>,
): void {
  // 呼び出し元のトランザクションで、理由を盤面・棋譜と一緒に保存します。
  if (event.type === "eliminate")
    room.eliminations.push({ color: event.color, reason: event.reason });
  const saved = storage.kv.get(replayKey);
  if (saved === undefined) throw new Error("Missing Gomoku replay");
  const replay = roundReplaySchema.parse(saved);
  replay.steps.push(roundReplaySchema.shape.steps.element.parse({ action: event, game: state }));
  storage.kv.put(replayKey, replay);
}

export function finalizeGomokuRound(
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
