import { colors } from "@tetraboard/four-reversi";
import type { Position } from "@tetraboard/four-reversi";
import {
  fourReversiDefinition as definition,
  type FourReversiTypes,
} from "@tetraboard/four-reversi/definition";
import { isClockExpired } from "./clock";
import { cpuMoveDelayMs } from "./progressHelpers";
import { matchStartKey, type MatchStart } from "./matchStore";
import type { PlayingFor } from "./gameProgress";
import { z } from "zod";
import { sameServiceProfile, serviceProfileSchema, type ServiceProfile } from "./aiServiceProfiles";
import {
  currentExternalCpuJob,
  prepareExternalCpu,
  completeExternalCpu,
  type ExternalCpuRuntime,
} from "./externalCpu";
type Playing = PlayingFor<"four-reversi">;
const external = definition.cpu.external!;
export const fourReversiCpuJobKey = "four-reversi-cpu-job";
export const fourReversiAiJobKey = "four-reversi-ai-job";
const cpuJobSchema = z.object({
  instanceId: z.string(),
  roundId: z.string().nullable(),
  playerId: z.string(),
  color: z.enum(colors),
  level: z.union([z.literal(1), z.literal(2)]),
  turnStartedAt: z.number().finite(),
  positionKey: z.string(),
  move: z.object({ x: z.number().int().min(0).max(7), y: z.number().int().min(0).max(7) }),
  applyAt: z.number().finite().nonnegative(),
  source: z.enum(["external", "fallback"]).optional(),
  requestId: z.string().uuid().optional(),
  serviceProfile: serviceProfileSchema.optional(),
  extendedRules: z.literal(true).optional(),
});
export type FourReversiCpuJob = z.infer<typeof cpuJobSchema>;
const externalJobSchema = cpuJobSchema
  .omit({ move: true, applyAt: true, source: true, requestId: true })
  .extend({
    requestId: z.string().uuid(),
    expiresAt: z.number().finite().nonnegative(),
  });
type ExternalCpuJob = z.infer<typeof externalJobSchema>;
export type ExternalCpuWork = { job: ExternalCpuJob; game: Playing["game"] };
export const supportsExternalAi = (room: Playing) =>
  room.game.mode === "singles" &&
  (room.game.eliminatedColors.length === 0 || room.matchmaking !== undefined);

export class FourReversiCpu {
  constructor(private readonly storage: DurableObjectStorage) {}
  cpuJob(room: Playing): FourReversiCpuJob | null {
    const parsed = cpuJobSchema.safeParse(this.storage.kv.get(fourReversiCpuJobKey));
    if (!parsed.success) return null;
    const job = parsed.data;
    const cpu = room.players.find((p) => p.color === room.game.turn);
    return cpu?.kind === "cpu" &&
      job.instanceId === room.instanceId &&
      job.roundId === (this.storage.kv.get<MatchStart>(matchStartKey)?.id ?? null) &&
      job.playerId === cpu.id &&
      job.color === cpu.color &&
      job.level === cpu.level &&
      job.turnStartedAt === room.clock.turnStartedAt &&
      job.positionKey === external.getPositionKey(room.game)
      ? job
      : null;
  }

  cpu(room: Playing, now: number) {
    if (room.clock.turnStartedAt + cpuMoveDelayMs > now || isClockExpired(room.clock, now))
      return null;
    const cpu = room.players.find((p) => p.color === room.game.turn);
    if (cpu?.kind !== "cpu") return null;
    if (this.storage.kv.get(fourReversiCpuJobKey) !== undefined) {
      const job = this.cpuJob(room);
      if (!job) this.storage.kv.delete(fourReversiCpuJobKey);
      else if (job.applyAt <= now) {
        const result = definition.rules.applyAction(room.game, job.color, {
          type: "placeStone",
          position: job.move,
        });
        if (!result.ok) this.storage.kv.delete(fourReversiCpuJobKey);
        else {
          if (job.source !== "external") {
            const start = this.storage.kv.get<MatchStart>(matchStartKey);
            if (start?.fourReversiRating && !start.fourReversiRating.usedFallback)
              this.storage.kv.put(matchStartKey, {
                ...start,
                fourReversiRating: { ...start.fourReversiRating, usedFallback: true },
              } satisfies MatchStart);
          }
          return result;
        }
      }
    } else {
      const action = cpu.cpuProfile
        ? external.fallbackAction(room.game, cpu.color)
        : definition.cpu.chooseAction(room.game, cpu.color, cpu.level, Math.random);
      if (action === null) throw new Error("CPU has no legal move");
      // Workersの同期計算中は時刻が進まないため、別イベントで期限を読み直します。
      this.storage.kv.put(fourReversiCpuJobKey, {
        instanceId: room.instanceId,
        roundId: this.storage.kv.get<MatchStart>(matchStartKey)?.id ?? null,
        playerId: cpu.id,
        color: cpu.color,
        level: cpu.level,
        turnStartedAt: room.clock.turnStartedAt,
        positionKey: external.getPositionKey(room.game),
        move: action.position,
        applyAt: Date.now() + 1,
      } satisfies FourReversiCpuJob);
    }
    return null;
  }

  private matchesContext(room: Playing, job: ExternalCpuJob): boolean {
    const cpu = room.players.find((p) => p.color === room.game.turn);
    return (
      supportsExternalAi(room) &&
      cpu?.kind === "cpu" &&
      job.instanceId === room.instanceId &&
      job.roundId === (this.storage.kv.get<MatchStart>(matchStartKey)?.id ?? null) &&
      job.playerId === cpu.id &&
      job.color === cpu.color &&
      job.level === cpu.level &&
      job.turnStartedAt === room.clock.turnStartedAt
    );
  }

  private runtime(room: Playing): ExternalCpuRuntime<FourReversiTypes, ExternalCpuJob> {
    const cpu = room.players.find((p) => p.color === room.game.turn);
    return {
      definition,
      state: room.game,
      seat: room.game.turn,
      level: cpu?.kind === "cpu" ? cpu.level : 2,
      loadJob: () => {
        const parsed = externalJobSchema.safeParse(this.storage.kv.get(fourReversiAiJobKey));
        return parsed.success ? parsed.data : null;
      },
      hasJob: () => this.storage.kv.get(fourReversiAiJobKey) !== undefined,
      deleteJob: () => {
        this.storage.kv.delete(fourReversiAiJobKey);
      },
      saveJob: (job) => {
        this.storage.kv.put(fourReversiAiJobKey, job);
      },
      matchesContext: (job) => this.matchesContext(room, job),
      sameRequest: (current, job) => sameServiceProfile(current.serviceProfile, job.serviceProfile),
      clockExpired: (now) => isClockExpired(room.clock, now),
      hasCpuJob: () => this.storage.kv.get(fourReversiCpuJobKey) !== undefined,
      saveAction: (job, action, now, external) => {
        const { expiresAt: _expiresAt, ...context } = job;
        this.storage.kv.put(fourReversiCpuJobKey, {
          ...context,
          move: action.position,
          applyAt: now + 1,
          source: external ? "external" : "fallback",
        } satisfies FourReversiCpuJob);
      },
    };
  }

  externalCpuJob(room: Playing): ExternalCpuJob | null {
    return currentExternalCpuJob(this.runtime(room));
  }

  prepareExternalCpu(
    room: Playing,
    now: number,
    timeoutMs: number,
    serviceProfile?: ServiceProfile,
  ): ExternalCpuWork | null {
    if (!supportsExternalAi(room) || room.clock.turnStartedAt + cpuMoveDelayMs > now) return null;
    const cpu = room.players.find((p) => p.color === room.game.turn);
    const job = prepareExternalCpu(
      this.runtime(room),
      cpu?.kind === "cpu"
        ? {
            instanceId: room.instanceId,
            roundId: this.storage.kv.get<MatchStart>(matchStartKey)?.id ?? null,
            playerId: cpu.id,
            color: cpu.color,
            level: cpu.level,
            turnStartedAt: room.clock.turnStartedAt,
            positionKey: external.getPositionKey(room.game),
            ...(cpu.level === 2 && serviceProfile ? { serviceProfile } : {}),
            ...(room.matchmaking ? { extendedRules: true as const } : {}),
          }
        : null,
      now,
      Math.min(room.clock.turnExpiresAt, now + timeoutMs + 250),
    );
    if (!job) return null;
    return { job, game: room.game };
  }

  completeExternalCpu(
    room: Playing,
    job: ExternalCpuJob,
    position: Position | null,
    now: number,
  ): boolean {
    return completeExternalCpu(this.runtime(room), job, position, now);
  }
}
