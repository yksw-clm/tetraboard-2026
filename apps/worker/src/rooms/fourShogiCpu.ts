import {
  fourShogiDefinition as definition,
  type FourShogiTypes,
} from "@tetraboard/four-shogi/definition";
import type { FourShogiReplayEvent } from "@tetraboard/protocol";
import type { Side, FourShogiAction } from "@tetraboard/four-shogi";
import { calibratedFourShogiProfile } from "../adapters/matchmaking/fourShogiSelection";
import type { FourShogiAiFailure, FourShogiAiResult } from "../adapters/room/ai/fourShogiAi";
import type { PlayingFor } from "./gameProgress";
import type { ShogiStore } from "./shogiStore";
import { shogiMatchStartKey, type ActiveShogiMatch } from "./shogiMatchStore";
import { shogiCpuJobKey } from "./progressHelpers";
import { isClockExpired } from "../adapters/room/clock";
import {
  currentExternalCpuJob,
  prepareExternalCpu,
  completeExternalCpu,
  type ExternalCpuRuntime,
  type ExternalCpuJob,
} from "../adapters/room/ai/externalCpu";

type Playing = PlayingFor<"four-shogi">;
export const fourShogiAiJobKey = "four-shogi-ai-job";
type FourShogiAiJob = {
  requestId: string;
  roundId: string;
  positionRevision: number;
  side: Side;
  expiresAt: number;
};
export type FourShogiAiWork = {
  job: FourShogiAiJob;
  events: FourShogiReplayEvent[];
  profile: NonNullable<ReturnType<typeof calibratedFourShogiProfile>>;
};
type FourShogiFallbackReason =
  | FourShogiAiFailure
  | "expired_job"
  | "invalid_profile"
  | "capacity_unavailable"
  | "replay_too_long"
  | "illegal_move";
export type FourShogiCpuResponse =
  | FourShogiAiResult
  | { action: null; reason: FourShogiFallbackReason };
export type ShogiCpuJob = {
  roundId: string;
  positionRevision: number;
  side: Side;
  action: FourShogiAction;
  applyAt: number;
  fallback?: true;
  aiDiagnostic?: { requestId: string; reason?: FourShogiFallbackReason };
};
type Job = FourShogiAiJob & ExternalCpuJob;
const external = definition.cpu.external!;

export class FourShogiCpu {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly store: () => ShogiStore,
  ) {}

  private runtime(
    room: Playing,
    response?: FourShogiCpuResponse,
  ): ExternalCpuRuntime<FourShogiTypes, Job> {
    const { state, repetitionLookup } = this.store().loadTransition(room.roundId, room.game);
    const cpu = room.players.find((p) => p.side === room.game.turn);
    return {
      definition,
      state,
      seat: room.game.turn,
      level: cpu?.kind === "cpu" ? cpu.level : 2,
      history: repetitionLookup,
      loadJob: () => {
        const job = this.storage.kv.get<FourShogiAiJob>(fourShogiAiJobKey);
        // 保存形式を保ち、局ID・revision・手番で照合する局面のキーを補います。
        return job ? { ...job, positionKey: external.getPositionKey(state) } : null;
      },
      hasJob: () => this.storage.kv.get(fourShogiAiJobKey) !== undefined,
      deleteJob: () => {
        this.storage.kv.delete(fourShogiAiJobKey);
      },
      saveJob: ({ positionKey: _key, ...job }) => {
        this.storage.kv.put(fourShogiAiJobKey, job);
      },
      matchesContext: (job) =>
        job.roundId === room.roundId &&
        job.positionRevision === room.positionRevision &&
        job.side === room.game.turn,
      sameRequest: (current, job) =>
        current.roundId === job.roundId &&
        current.positionRevision === job.positionRevision &&
        current.side === job.side,
      clockExpired: (now) => isClockExpired(room.clock, now),
      hasCpuJob: () => this.storage.kv.get(shogiCpuJobKey) !== undefined,
      saveAction: (job, action, now, legal) => this.saveAction(job, action, now, legal, response),
    };
  }

  private saveAction(
    job: Job,
    action: FourShogiTypes["action"],
    now: number,
    legal: boolean,
    response?: FourShogiCpuResponse,
  ) {
    if (action.type === "drawProposal") throw new Error("Unexpected CPU draw proposal");
    const aiDiagnostic = !legal
      ? {
          requestId: job.requestId,
          reason: response?.reason ?? (now >= job.expiresAt ? "timeout" : "illegal_move"),
        }
      : response && "retried" in response && response.retried
        ? { requestId: job.requestId }
        : undefined;
    this.storage.kv.put(shogiCpuJobKey, {
      roundId: job.roundId,
      positionRevision: job.positionRevision,
      side: job.side,
      action,
      applyAt: now + 1,
      ...(!legal ? { fallback: true as const } : {}),
      ...(aiDiagnostic ? { aiDiagnostic } : {}),
    } satisfies ShogiCpuJob);
  }

  externalCpuJob(room: Playing): FourShogiAiJob | undefined {
    const job = currentExternalCpuJob(this.runtime(room));
    if (!job) return undefined;
    const { positionKey: _key, ...saved } = job;
    return saved;
  }

  prepareExternalCpu(
    room: Playing,
    now: number,
    timeout: number,
    unavailable: "configuration" | "capacity_unavailable" | null,
  ): FourShogiAiWork | null {
    const pending = this.externalCpuJob(room);
    if (pending) {
      if (now >= pending.expiresAt)
        this.completeExternalCpu(room, pending, { action: null, reason: "expired_job" }, now);
      return null;
    }
    const runtime = this.runtime(room);
    if (runtime.hasJob()) runtime.deleteJob();
    const job = prepareExternalCpu<
      FourShogiTypes,
      Pick<Job, "roundId" | "positionRevision" | "side">
    >(
      runtime,
      { roundId: room.roundId, positionRevision: room.positionRevision, side: room.game.turn },
      now,
      Math.min(room.clock.turnExpiresAt, now + timeout),
    );
    if (!job) return null;
    const { positionKey: _key, ...saved } = job;
    return this.prepareWork(room, saved, now, unavailable);
  }

  private prepareWork(
    room: Playing,
    job: FourShogiAiJob,
    now: number,
    unavailable: "configuration" | "capacity_unavailable" | null,
  ): FourShogiAiWork | null {
    const active = this.storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey);
    const ref =
      active?.start.id === room.roundId
        ? active.start.fourShogiRating?.cpu[room.game.turn]
        : undefined;
    const profile = ref && calibratedFourShogiProfile(ref);
    const count = this.store().eventCount(room.roundId);
    if (!profile || unavailable || count > 1600) {
      const reason = !profile ? "invalid_profile" : (unavailable ?? "replay_too_long");
      this.completeExternalCpu(room, job, { action: null, reason }, now);
      return null;
    }
    const events: FourShogiReplayEvent[] = [];
    while (events.length < count) {
      const page = this.store().replayEvents(room.roundId, events.length);
      if (!page.length) throw Error("四人将棋の棋譜が不足しています");
      events.push(...page);
    }
    return { job, events, profile };
  }

  completeExternalCpu(
    room: Playing,
    job: FourShogiAiJob,
    response: FourShogiCpuResponse,
    now: number,
  ) {
    const runtime = this.runtime(room, response);
    completeExternalCpu(
      runtime,
      { ...job, positionKey: external.getPositionKey(runtime.state) },
      response.action,
      now,
    );
  }
  cpu(room: Playing, now: number) {
    const cpu = room.players.find((p) => p.side === room.game.turn);
    if (cpu?.kind !== "cpu") return null;
    const job = this.storage.kv.get<ShogiCpuJob>(shogiCpuJobKey);
    if (job) {
      if (
        job.roundId !== room.roundId ||
        job.positionRevision !== room.positionRevision ||
        job.side !== room.game.turn
      )
        this.storage.kv.delete(shogiCpuJobKey);
      else if (job.applyAt <= now) {
        const { state, repetitionLookup } = this.store().loadTransition(room.roundId, room.game);
        const result = definition.rules.applyAction(state, job.side, job.action, repetitionLookup);
        if (!result.ok) throw new Error("Saved CPU action is no longer legal");
        if (job.fallback) {
          const active = this.storage.kv.get<ActiveShogiMatch>(shogiMatchStartKey);
          if (active?.start.id === room.roundId && active.start.fourShogiRating) {
            active.start.fourShogiRating.usedFallback = true;
            this.storage.kv.put(shogiMatchStartKey, active);
          }
        }
        return result;
      }
    } else if (!room.matchmaking?.rated) {
      const { state, repetitionLookup } = this.store().loadTransition(room.roundId, room.game);
      const action = definition.cpu.chooseAction(
        state,
        cpu.side,
        cpu.level,
        Math.random,
        repetitionLookup,
      );
      if (!action) throw new Error("Shogi CPU has no legal action");
      if (action.type === "drawProposal") throw new Error("Unexpected CPU draw proposal");
      this.storage.kv.put(shogiCpuJobKey, {
        roundId: room.roundId,
        positionRevision: room.positionRevision,
        side: room.game.turn,
        action,
        applyAt: Date.now() + 1,
      } satisfies ShogiCpuJob);
    }
    return null;
  }
  cpuDraw(room: Playing) {
    const cpu = room.players.find((p) => p.side === room.game.turn);
    if (cpu?.kind !== "cpu") return null;
    const humans = room.players.filter(
      (p) => p.kind === "human" && !room.game.eliminations.some((e) => e.side === p.side),
    );
    const proposed =
      humans.length > 0 && humans.every((p) => room.game.drawProposals.includes(p.side));
    if (room.game.drawProposals.includes(cpu.side) === proposed) return null;
    const { state } = this.store().loadTransition(room.roundId, room.game);
    const result = definition.rules.applyAction(state, cpu.side, {
      type: "drawProposal",
      proposed,
    });
    if (!result.ok) throw new Error("Could not update CPU draw proposal");
    return result;
  }
}
