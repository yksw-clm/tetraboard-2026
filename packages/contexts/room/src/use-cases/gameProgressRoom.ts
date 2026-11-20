import type { GameId, RoomFor } from "@tetraboard/protocol";
import type { ProgressFor, RematchFor, WaitingFor } from "./gameProgress";
import type {
  GameProgressSpec,
  PreparedLeave,
  ProgressGameTypes,
  ProgressPlayingRoom,
  ProgressRoom,
  SavedProgressState,
} from "./gameProgressSpec";
import { nextPublicUpdateAt } from "./ports";

export type ProgressAcceptance<G extends GameId> = {
  clockAt?: number;
  positionChanged?: boolean;
  saved?: SavedProgressState<G>;
};

export function expectPlaying<G extends GameId, T extends ProgressGameTypes>(
  room: ProgressRoom<G, T>,
): ProgressPlayingRoom<G, T> {
  if (room.status !== "playing") throw new Error("Expected playing room");
  return room;
}

// 操作や脱落を記録した後、その局面をルームに反映します。
export function acceptProgressState<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[],
  Prepared extends PreparedLeave<T>,
>(
  spec: GameProgressSpec<G, T, StartArgs, Prepared>,
  room: ProgressPlayingRoom<G, T>,
  state: T["state"],
  at: number,
  turnEnded: boolean,
  { clockAt = at, positionChanged = true, saved }: ProgressAcceptance<G> = {},
): ProgressFor<G> {
  const { store, gameId, parseFinishedState, parseRoom, advanceClock } = spec;
  if (spec.clearCpuJobsOnAccept) spec.clearCpuJobsOnAccept();
  else store.cpuJobs?.delete();
  const positionRevision = room.positionRevision + (positionChanged ? 1 : 0);
  if (state.status === "finished") {
    const game = parseFinishedState(state, saved);
    const finishedRoom = spec.incrementRevisionOnFinish ? { ...room, positionRevision } : room;
    return { kind: "finished", gameId, room: finishedRoom, game, at };
  }

  const updated = parseRoom({
    ...room,
    game: saved ?? state,
    positionRevision,
    ...spec.playingFields?.(state),
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
  return { kind: "playing", gameId, room: expectPlaying<G, T>(updated) };
}

export function waitingProgressRoom<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[],
  Prepared extends PreparedLeave<T>,
>(
  spec: GameProgressSpec<G, T, StartArgs, Prepared>,
  data: RematchFor<G>,
  players: RoomFor<G>["players"],
): WaitingFor<G> {
  const room = spec.parseRoom({
    ...data.room,
    status: "waiting",
    roundId: null,
    positionRevision: 0,
    eliminations: [],
    publicUpdatedAtMs: nextPublicUpdateAt(data.room, spec.now()),
    lastActivityAtMs: data.at,
    players: players.map((p) => ({ ...p, ...spec.waitingSeat })),
    game: null,
    clock: null,
    lastRound: data.lastRound,
    ...spec.waitingFields,
  });
  if (room.status !== "waiting") throw new Error("Expected waiting room");
  return room;
}
