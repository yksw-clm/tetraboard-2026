import { isFourReversiRoom } from "@tetraboard/protocol";
import type { FourReversiProgress } from "../fourReversiProgress";
import { fourReversiCpuJobKey, supportsExternalAi } from "../fourReversiProgress";
import {
  aiServiceConfigured,
  aiServiceEnabled,
  fourReversiAiServiceTimeout,
  requestAiMove,
  roomAiAllowed,
} from "../aiService";
import { serviceProfile } from "../aiServiceProfiles";
import { cpuMoveDelayMs } from "../progressHelpers";
import type { ExternalCpuWork } from "../fourReversiProgress";
import type { PlayingFor } from "../gameProgress";
import type { AdapterDependencies } from "./types";
import type { CpuStepContext, ExternalCpuRequest, GameCpuAdapter } from "./cpuTypes";
import { applyCpuProgress, cpuDefaults } from "./cpuBase";

function externalRequest(
  progress: FourReversiProgress,
  dependencies: AdapterDependencies,
  work: ExternalCpuWork,
): ExternalCpuRequest {
  return {
    request: async () => {
      const response = await requestAiMove(dependencies.aiService(), work);
      return {
        apply: (room, now) => {
          if (room?.status === "playing" && isFourReversiRoom(room))
            progress.completeExternalCpu(room, work.job, response.position, now);
        },
        afterTransaction: () => {
          if (response.reason) console.warn("AI service fallback", { reason: response.reason });
        },
      };
    },
  };
}

function step(
  progress: FourReversiProgress,
  dependencies: AdapterDependencies,
  room: PlayingFor<"four-reversi">,
  context: CpuStepContext<"four-reversi">,
) {
  if (room.players.find((player) => player.color === room.game.turn)?.kind !== "cpu")
    return { room };
  const bindings = dependencies.aiService();
  if (
    roomAiAllowed(bindings, room) &&
    aiServiceEnabled(bindings) &&
    supportsExternalAi(room) &&
    dependencies.storage.kv.get(fourReversiCpuJobKey) === undefined
  ) {
    const cpu = room.players.find((player) => player.color === room.game.turn);
    const profile = cpu?.kind === "cpu" ? cpu.cpuProfile : undefined;
    const work = progress.prepareExternalCpu(
      room,
      context.now,
      fourReversiAiServiceTimeout(bindings),
      profile
        ? {
            profile_id: profile.id,
            profile_hash: profile.hash,
            engine_version: profile.engineVersion,
          }
        : serviceProfile(bindings),
    );
    if (work && !context.hasCapacity(room)) {
      progress.completeExternalCpu(room, work.job, null, context.now);
      return { room };
    }
    return { room, external: work ? externalRequest(progress, dependencies, work) : null };
  }
  return { room: applyCpuProgress(progress.cpu(room, context.now), context) };
}

export function fourReversiCpu(
  progress: FourReversiProgress,
  dependencies: AdapterDependencies,
): GameCpuAdapter<"four-reversi"> {
  return {
    ...cpuDefaults<"four-reversi">(progress, (room) =>
      room.players.find((player) => player.color === room.game.turn),
    ),
    usesIdleDeadline: (room) => !(room.status === "playing" && room.matchmaking?.rated === true),
    keepsPlayingWithoutHumans: (room) =>
      room.status === "playing" && room.matchmaking?.rated === true,
    capacity: {
      game: (room) =>
        roomAiAllowed(dependencies.aiService(), room) &&
        room.settings.mode === "singles" &&
        aiServiceConfigured(dependencies.aiService())
          ? "four-reversi"
          : null,
      seats: (room) => room.players.filter((player) => player.kind === "cpu").length,
      recoverPlaying: supportsExternalAi,
    },
    alarmAt: (room) => {
      const job = progress.cpuJob(room);
      const earliest = room.clock.turnStartedAt + cpuMoveDelayMs;
      const external =
        roomAiAllowed(dependencies.aiService(), room) && aiServiceEnabled(dependencies.aiService())
          ? progress.externalCpuJob(room)
          : null;
      return external ? external.expiresAt : job ? Math.max(job.applyAt, earliest) : earliest;
    },
    step: (room, context) => step(progress, dependencies, room, context),
  };
}
