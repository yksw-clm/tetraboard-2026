import { isShogiRoom } from "@tetraboard/protocol";
import type { ShogiProgress } from "./progress";
import { shogiCpuJobKey } from "./cpu";
import { aiServiceTimeout, roomAiAllowed } from "../../ai/aiService";
import { requestShogiAiMove, shogiAiEnabled } from "../../ai/shogiAi";
import type { ShogiAiWork } from "../../ai/shogiAi";
import type { PlayingFor } from "../gameProgress";
import type { AdapterDependencies } from "../types";
import type {
  CpuStepContext,
  CpuStepResult,
  ExternalCpuRequest,
  GameCpuAdapter,
} from "../cpuTypes";
import { applyCpuProgress, cpuDefaults, savedCpuAlarm } from "../cpuBase";

function externalRequest(
  progress: ShogiProgress,
  dependencies: AdapterDependencies,
  work: ShogiAiWork,
): ExternalCpuRequest {
  return {
    request: async () => {
      const move = await requestShogiAiMove(dependencies.aiService(), work);
      return {
        apply: (room, now) => {
          if (room?.status === "playing" && isShogiRoom(room))
            progress.completeExternalCpu(room, work, move, now);
        },
      };
    },
  };
}

function step(
  progress: ShogiProgress,
  dependencies: AdapterDependencies,
  initial: PlayingFor<"shogi">,
  context: CpuStepContext<"shogi">,
): CpuStepResult<"shogi"> {
  if (initial.players.find((player) => player.side === initial.game.turn)?.kind !== "cpu")
    return { room: initial };
  const room = applyCpuProgress(progress.cpuDraw(initial, context.now), context);
  if (!room || room.status !== "playing") return { room };
  if (!isShogiRoom(room)) throw new Error("Expected Shogi room");
  let external: ExternalCpuRequest | null = null;
  if (
    roomAiAllowed(dependencies.aiService(), room) &&
    shogiAiEnabled(dependencies.aiService()) &&
    context.hasCapacity(room)
  ) {
    const work = progress.prepareExternalCpu(
      room,
      context.now,
      aiServiceTimeout(dependencies.aiService()),
    );
    external = work ? externalRequest(progress, dependencies, work) : null;
    const pending = progress.externalCpuJob(room);
    if (pending && pending.expiresAt > context.now) return { room, external };
  }
  return { room: applyCpuProgress(progress.cpu(room, context.now), context), external };
}

export function shogiCpu(
  progress: ShogiProgress,
  dependencies: AdapterDependencies,
): GameCpuAdapter<"shogi"> {
  const defaults = cpuDefaults<"shogi">(
    progress,
    (room) => room.players.find((player) => player.side === room.game.turn),
    "Missing timed-out shogi player",
  );
  return {
    ...defaults,
    usesIdleDeadline: (room) => !(room.status === "playing" && room.matchmaking),
    capacity: {
      game: (room) =>
        roomAiAllowed(dependencies.aiService(), room) && shogiAiEnabled(dependencies.aiService())
          ? "shogi"
          : null,
      seats: (room) =>
        room.players.filter((player) => player.kind === "cpu" && player.level === 2).length,
      recoverPlaying: (room) => defaults.currentCpu(room)?.level === 2,
    },
    alarmAt: (room) => {
      const external =
        roomAiAllowed(dependencies.aiService(), room) && shogiAiEnabled(dependencies.aiService())
          ? progress.externalCpuJob(room)
          : null;
      return external
        ? external.expiresAt
        : savedCpuAlarm(dependencies.storage, shogiCpuJobKey, room);
    },
    step: (room, context) => step(progress, dependencies, room, context),
  };
}
