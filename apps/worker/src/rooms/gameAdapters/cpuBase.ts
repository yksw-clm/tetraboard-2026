import type { GameId, RoomFor } from "@tetraboard/protocol";
import type { PlayingFor, ProgressFor } from "../gameProgress";
import { cpuMoveDelayMs } from "../progressHelpers";
import type { CpuPlayerFor, CpuStepContext, GameCpuAdapter } from "./cpuTypes";

type CpuProgress<G extends GameId> = {
  cpu(room: PlayingFor<G>, now: number): ProgressFor<G>;
  eliminate(
    room: PlayingFor<G>,
    playerId: string,
    reason: "timeout" | "disconnected",
    at: number,
  ): ProgressFor<G>;
};

export function applyCpuProgress<G extends GameId>(
  result: ProgressFor<G>,
  context: CpuStepContext<G>,
): RoomFor<G> | null {
  return result.kind === "unchanged" ? result.room : context.applyProgress(result);
}

export function cpuDefaults<G extends GameId>(
  progress: CpuProgress<G>,
  currentPlayer: (room: PlayingFor<G>) => RoomFor<G>["players"][number] | undefined,
  missingPlayer = "Missing timed-out player",
): GameCpuAdapter<G> {
  return {
    currentCpu: (room) => {
      const player = room.status === "playing" ? currentPlayer(room as PlayingFor<G>) : undefined;
      return player?.kind === "cpu" ? (player as CpuPlayerFor<G>) : null;
    },
    usesIdleDeadline: () => true,
    keepsPlayingWithoutHumans: () => false,
    reloadBeforeDeadlines: false,
    waitUntilMatchFlush: true,
    capacity: { game: () => null, seats: () => 0, recoverPlaying: () => true },
    timeout: (room, at) => {
      const player = currentPlayer(room);
      if (!player) throw new Error(missingPlayer);
      return progress.eliminate(room, player.id, "timeout", at);
    },
    disconnect: (room, playerId, at) => progress.eliminate(room, playerId, "disconnected", at),
    alarmAt: (room) => room.clock.turnStartedAt + cpuMoveDelayMs,
    step: (room, context) => ({
      room:
        currentPlayer(room)?.kind === "cpu"
          ? applyCpuProgress(progress.cpu(room, context.now), context)
          : room,
    }),
  };
}

export function savedCpuAlarm(
  storage: DurableObjectStorage,
  key: string,
  room: { clock: { turnStartedAt: number } },
): number {
  const job = storage.kv.get<{ applyAt: number }>(key);
  const earliest = room.clock.turnStartedAt + cpuMoveDelayMs;
  return job ? Math.max(job.applyAt, earliest) : earliest;
}
