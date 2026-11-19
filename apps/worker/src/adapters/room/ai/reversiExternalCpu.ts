import { getLegalMoves, type Position } from "@tetraboard/reversi";
import { gameDefinitions } from "../../../rooms/gameDefinitions";
import type { ReversiAiWork } from "./reversiAi";
import type { PlayingFor } from "../../../rooms/gameProgress";
import { matchStartKey, type MatchStart } from "../../../rooms/reversiMatchStore";
import { externalCpuJobKey } from "../../../rooms/reversiProgressStore";
import { isClockExpired } from "../../../rooms/reversiClock";
import { reversiCpuProfile } from "../../matchmaking/reversiCpuProfiles";

type Playing = PlayingFor<"reversi">;
type ExternalCpuJob = ReversiAiWork["job"] & { position?: Position | null };

export class ReversiExternalCpu {
  constructor(private readonly storage: DurableObjectStorage) {}
  externalCpuJob(room: Playing): ExternalCpuJob | undefined {
    const job = this.storage.kv.get<ExternalCpuJob>(externalCpuJobKey);
    return job &&
      job.moveNumber === room.game.moveNumber &&
      job.roundId === this.storage.kv.get<MatchStart>(matchStartKey)?.id
      ? job
      : undefined;
  }

  prepareExternalCpu(room: Playing, now: number, timeout: number): ReversiAiWork | null {
    const cpu = room.players.find((p) => p.color === room.game.turn);
    const match = this.storage.kv.get<MatchStart>(matchStartKey);
    if (cpu?.kind !== "cpu" || cpu.level !== 2 || !match || this.externalCpuJob(room)) return null;
    const profile = match.rating?.kind === "cpu" ? reversiCpuProfile(match.rating) : undefined;
    if (match.rating && !profile) return null;
    const job = {
      requestId: crypto.randomUUID(),
      roundId: match.id,
      moveNumber: room.game.moveNumber,
      expiresAt: Math.min(now + timeout, room.clock.turnExpiresAt),
    };
    if (profile && profile.engineProbability < 1 && Math.random() >= profile.engineProbability) {
      this.storage.kv.put(externalCpuJobKey, {
        ...job,
        position:
          gameDefinitions.reversi.cpu.chooseAction(room.game, cpu.color, 1, Math.random)
            ?.position ?? null,
      });
      return null;
    }
    this.storage.kv.put(externalCpuJobKey, job);
    const board = room.game.board
      .flat()
      .map((cell) => (cell === "black" ? "B" : cell === "white" ? "W" : "-"))
      .join("");
    return { job, board, blackToMove: room.game.turn === "black", level: profile?.level ?? 4 };
  }

  completeExternalCpu(room: Playing, work: ReversiAiWork, move: Position | null, now: number) {
    const job = this.externalCpuJob(room);
    if (
      !job ||
      job.requestId !== work.job.requestId ||
      job.position !== undefined ||
      isClockExpired(room.clock, now)
    )
      return "stale";
    const position =
      now < job.expiresAt &&
      move &&
      getLegalMoves(room.game).some(({ x, y }) => x === move.x && y === move.y)
        ? move
        : null;
    this.storage.kv.put(externalCpuJobKey, { ...job, position });
    return position ? "engine" : "fallback";
  }

  recordFallback(job: ExternalCpuJob | undefined): void {
    const match = this.storage.kv.get<MatchStart>(matchStartKey);
    if ((job || match?.rating?.kind === "cpu") && !job?.position && match && !match.aiFallback) {
      const rating = match.rating;
      this.storage.kv.put(matchStartKey, {
        ...match,
        aiFallback: true,
        ...(rating?.kind === "cpu" ? { rating: { ...rating, usedFallback: true } } : {}),
      } satisfies MatchStart);
    }
  }
}
