import { isFourShogiRoom } from "@tetraboard/protocol";
import type { FourShogiProgress, FourShogiAiWork, ShogiCpuJob } from "../fourShogiProgress";
import {
  aiServiceConfigured,
  aiServiceTimeout,
  requestFourShogiAiMove,
  roomAiAllowed,
} from "../aiService";
import type { PlayingFor } from "../gameProgress";
import { shogiCpuJobKey } from "../progressHelpers";
import type { AdapterDependencies } from "./types";
import type { CpuStepContext, CpuStepResult, ExternalCpuRequest, GameCpuAdapter } from "./cpuTypes";
import { applyCpuProgress, cpuDefaults, savedCpuAlarm } from "./cpuBase";

function externalRequest(
  progress: FourShogiProgress,
  dependencies: AdapterDependencies,
  work: FourShogiAiWork,
): ExternalCpuRequest {
  return {
    request: async () => {
      const response = await requestFourShogiAiMove(dependencies.aiService(), work);
      return {
        apply: (room, now) => {
          if (room?.status === "playing" && isFourShogiRoom(room))
            progress.completeExternalCpu(room, work.job, response, now);
        },
      };
    },
  };
}

function step(
  progress: FourShogiProgress,
  dependencies: AdapterDependencies,
  initial: PlayingFor<"four-shogi">,
  context: CpuStepContext<"four-shogi">,
): CpuStepResult<"four-shogi"> {
  if (initial.players.find((player) => player.side === initial.game.turn)?.kind !== "cpu")
    return { room: initial };
  const room = applyCpuProgress(progress.cpuDraw(initial, context.now), context);
  if (!room || room.status !== "playing") return { room };
  if (!isFourShogiRoom(room)) throw new Error("Expected Shogi room");
  const cpuJob = dependencies.storage.kv.get<ShogiCpuJob>(shogiCpuJobKey);
  if (room.matchmaking?.rated && !cpuJob) {
    const work = progress.prepareExternalCpu(
      room,
      context.now,
      aiServiceTimeout(dependencies.aiService()),
      !aiServiceConfigured(dependencies.aiService())
        ? "configuration"
        : context.hasCapacity(room)
          ? null
          : "capacity_unavailable",
    );
    return { room, external: work ? externalRequest(progress, dependencies, work) : null };
  }
  const result = progress.cpu(room, context.now);
  const diagnostic =
    result.kind !== "unchanged" && cpuJob?.aiDiagnostic
      ? { matchId: room.roundId, ...cpuJob.aiDiagnostic }
      : undefined;
  return {
    room: applyCpuProgress(result, context),
    afterTransaction: diagnostic
      ? () =>
          dependencies.logFourShogiDiagnostic(
            diagnostic.reason ? "four_shogi_ai_fallback_applied" : "four_shogi_ai_retry_applied",
            diagnostic,
          )
      : undefined,
  };
}

export function fourShogiCpu(
  progress: FourShogiProgress,
  dependencies: AdapterDependencies,
): GameCpuAdapter<"four-shogi"> {
  return {
    ...cpuDefaults<"four-shogi">(progress, (room) =>
      room.players.find((player) => player.side === room.game.turn),
    ),
    usesIdleDeadline: (room) => !(room.status === "playing" && room.matchmaking?.rated === true),
    keepsPlayingWithoutHumans: (room) =>
      room.status === "playing" && room.matchmaking?.rated === true,
    reloadBeforeDeadlines: true,
    waitUntilMatchFlush: false,
    capacity: {
      game: (room) =>
        roomAiAllowed(dependencies.aiService(), room) &&
        room.matchmaking?.rated &&
        aiServiceConfigured(dependencies.aiService())
          ? "four-shogi"
          : null,
      seats: (room) => room.players.filter((player) => player.kind === "cpu").length,
      recoverPlaying: () => true,
    },
    alarmAt: (room) => {
      const external = room.matchmaking?.rated ? progress.externalCpuJob(room) : null;
      return external
        ? external.expiresAt
        : savedCpuAlarm(dependencies.storage, shogiCpuJobKey, room);
    },
    step: (room, context) => step(progress, dependencies, room, context),
  };
}
