import type { GameId } from "@tetraboard/protocol";
import type { ProgressFor } from "./gameProgress";
import { applyGameCommand } from "./gameProgressCommands";
import {
  readProgressState,
  type GameProgressSpec,
  type PreparedLeave,
  type ProgressGameTypes,
  type ProgressPlayingRoom,
  type ProgressTransition,
} from "./gameProgressSpec";
import { cpuMoveDelayMs } from "./processDeadlines";

export function progressCpu<
  G extends GameId,
  T extends ProgressGameTypes,
  StartArgs extends unknown[],
  Prepared extends PreparedLeave<T>,
>(
  spec: GameProgressSpec<G, T, StartArgs, Prepared>,
  room: ProgressPlayingRoom<G, T>,
  now: number,
  accept: (transition: ProgressTransition<T>) => ProgressFor<G>,
): ProgressFor<G> {
  const { gameId, definition, isClockExpired, random = Math.random, seat, store } = spec;
  const jobs = store.cpuJobs;
  const unchanged = { kind: "unchanged", gameId, room } as const;
  if (!jobs) return unchanged;
  if (room.clock.turnStartedAt + cpuMoveDelayMs > now || isClockExpired(room.clock, now))
    return unchanged;
  const turn = room.game.turn;
  const cpu = room.players.find((p) => seat(p) === turn);
  if (cpu?.kind !== "cpu") return unchanged;
  const job = jobs.read();
  if (job) {
    if (
      job.roundId !== room.roundId ||
      job.positionRevision !== room.positionRevision ||
      job.seat !== turn
    ) {
      jobs.delete();
    } else if (job.applyAt <= now) {
      const { result } = applyGameCommand(spec, room, job.seat, job.action);
      if (!result.ok) throw new Error("Saved CPU move is no longer legal");
      return accept(result);
    }
    return unchanged;
  }
  const loaded = store.loadTransition?.(room, "play");
  const action = loaded
    ? definition.cpu.chooseAction(loaded.state, turn, cpu.level, random, loaded.history)
    : definition.cpu.chooseAction(readProgressState(spec, room), turn, cpu.level, random);
  if (action === null) throw new Error("CPU has no legal move");
  // Workersの同期計算中は時刻が進まないため、次のAlarmで期限を再確認します。
  jobs.write({
    roundId: room.roundId,
    positionRevision: room.positionRevision,
    seat: turn,
    action,
    applyAt: spec.now() + 1,
  });
  return unchanged;
}
