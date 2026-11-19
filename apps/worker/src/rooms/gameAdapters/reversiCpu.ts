import { isReversiRoom } from "@tetraboard/protocol";
import type { ReversiProgress } from "../reversiProgress";
import { aiServiceTimeout, roomAiAllowed } from "../../adapters/room/ai/aiService";
import { reversiAiEnabled, requestReversiAiMove } from "../../adapters/room/ai/reversiAi";
import type { ReversiAiWork } from "../../adapters/room/ai/reversiAi";
import { cpuMoveDelayMs } from "../progressHelpers";
import type { AdapterDependencies } from "./types";
import type { ExternalCpuRequest, GameCpuAdapter } from "./cpuTypes";
import { applyCpuProgress, cpuDefaults } from "./cpuBase";

function externalRequest(
  progress: ReversiProgress,
  dependencies: AdapterDependencies,
  work: ReversiAiWork,
): ExternalCpuRequest {
  return {
    request: async () => {
      const started = performance.now();
      const move = await requestReversiAiMove(dependencies.aiService(), work);
      const elapsedMs = Math.round(performance.now() - started);
      let source = "stale";
      return {
        apply: (room, now) => {
          source =
            room?.status === "playing" && isReversiRoom(room)
              ? progress.completeExternalCpu(room, work, move, now)
              : "stale";
        },
        afterTransaction: () => console.info("Reversi AI response", { source, elapsedMs }),
      };
    },
  };
}

export function reversiCpu(
  progress: ReversiProgress,
  dependencies: AdapterDependencies,
): GameCpuAdapter<"reversi"> {
  const defaults = cpuDefaults<"reversi">(progress, (room) =>
    room.players.find((player) => player.color === room.game.turn),
  );
  return {
    ...defaults,
    usesIdleDeadline: (room) => !(room.status === "playing" && room.matchmaking),
    capacity: {
      game: (room) =>
        roomAiAllowed(dependencies.aiService(), room) &&
        room.matchmaking &&
        reversiAiEnabled(dependencies.aiService())
          ? "reversi"
          : null,
      seats: (room) =>
        room.players.filter((player) => player.kind === "cpu" && player.level === 2).length,
      recoverPlaying: () => true,
    },
    alarmAt: (room) => {
      const job =
        roomAiAllowed(dependencies.aiService(), room) && reversiAiEnabled(dependencies.aiService())
          ? progress.externalCpuJob(room)
          : undefined;
      return job && job.position === undefined
        ? job.expiresAt
        : room.clock.turnStartedAt + cpuMoveDelayMs;
    },
    step: (room, context) => {
      let external: ExternalCpuRequest | null = null;
      if (
        roomAiAllowed(dependencies.aiService(), room) &&
        reversiAiEnabled(dependencies.aiService()) &&
        defaults.currentCpu(room)?.level === 2 &&
        (!room.matchmaking || context.hasCapacity(room))
      ) {
        const work = progress.prepareExternalCpu(
          room,
          context.now,
          aiServiceTimeout(dependencies.aiService()),
        );
        external = work ? externalRequest(progress, dependencies, work) : null;
        const pending = progress.externalCpuJob(room);
        if (pending && pending.position === undefined && context.now < pending.expiresAt)
          return { room, external };
      }
      return { room: applyCpuProgress(progress.cpu(room, context.now), context), external };
    },
  };
}
