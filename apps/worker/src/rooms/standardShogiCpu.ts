import {
  shogiDefinition as definition,
  usiMove,
  type ShogiTypes,
  type ShogiGameAction,
} from "@tetraboard/shogi/definition";
import { declarationStatus, type Side, type ShogiAction } from "@tetraboard/shogi";
import type { PlayingFor } from "./gameProgress";
import type { StandardShogiStore } from "./standardShogiStore";
import type { ActiveShogiMatch } from "./standardShogiProgressStore";
import { standardShogiMatchStartKey } from "./shogiMatchStore";
import { shogiCpuProfile } from "@tetraboard/context-matchmaking";
import type { ShogiAiWork } from "../adapters/room/ai/shogiAi";
import { isClockExpired } from "../adapters/room/clock";
import {
  currentExternalCpuJob,
  prepareExternalCpu,
  completeExternalCpu,
  type ExternalCpuRuntime,
  type ExternalCpuJob,
} from "../adapters/room/ai/externalCpu";

type Playing = PlayingFor<"shogi">;
export const shogiCpuJobKey = "standard-shogi-cpu-job";
export const externalShogiCpuJobKey = "standard-shogi-external-cpu-job";
export type ShogiCpuJob = {
  roundId: string;
  positionRevision: number;
  side: Side;
  action: ShogiAction | "declaration";
  applyAt: number;
  external?: true;
};
type Job = ShogiAiWork["job"] & ExternalCpuJob;
const external = definition.cpu.external!;

export class StandardShogiCpu {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly store: () => StandardShogiStore,
  ) {}

  private saveAction(room: Playing, action: ShogiGameAction, external: boolean, at: number) {
    if (action.type === "drawProposal") throw new Error("Unexpected CPU draw proposal");
    this.storage.kv.put(shogiCpuJobKey, {
      roundId: room.roundId,
      positionRevision: room.positionRevision,
      side: room.game.turn,
      action: action.type === "declaration" ? "declaration" : action,
      applyAt: at + 1,
      ...(external ? { external: true } : {}),
    } satisfies ShogiCpuJob);
  }

  private markFallback(room: Playing, job: ShogiCpuJob) {
    if (job.action === "declaration" || job.external) return;
    const active = this.storage.kv.get<ActiveShogiMatch>(standardShogiMatchStartKey);
    if (active?.start.id === room.roundId && active.start.rating?.kind === "cpu") {
      active.start.rating.usedFallback = true;
      this.storage.kv.put(standardShogiMatchStartKey, active);
    }
  }

  cpu(room: Playing, now: number, externalMove: string | null = null) {
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
        const result = definition.rules.applyAction(
          state,
          job.side,
          job.action === "declaration" ? { type: "declaration" } : job.action,
          repetitionLookup,
        );
        if (!result.ok) throw new Error("Saved CPU action is no longer legal");
        this.markFallback(room, job);
        return result;
      }
    } else {
      this.storage.kv.delete(externalShogiCpuJobKey);
      const { state, repetitionLookup } = this.store().loadTransition(room.roundId, room.game);
      const proposed = externalMove ? external.readMove(externalMove) : null;
      const externalAction =
        proposed && definition.rules.applyAction(state, cpu.side, proposed, repetitionLookup).ok
          ? proposed
          : null;
      const winning = declarationStatus(state, cpu.side).outcome === "win";
      const action = winning
        ? { type: "declaration" as const }
        : (externalAction ??
          definition.cpu.chooseAction(state, cpu.side, cpu.level, Math.random, repetitionLookup));
      if (!action) throw new Error("Shogi CPU has no legal action");
      this.saveAction(room, action, externalAction !== null, Date.now());
    }
    return null;
  }

  private runtime(room: Playing): ExternalCpuRuntime<ShogiTypes, Job> {
    const { state, repetitionLookup } = this.store().loadTransition(room.roundId, room.game);
    const cpu = room.players.find((p) => p.side === room.game.turn);
    return {
      definition,
      state,
      seat: room.game.turn,
      level: cpu?.kind === "cpu" ? cpu.level : 2,
      history: repetitionLookup,
      loadJob: () => {
        const job = this.storage.kv.get<ShogiAiWork["job"]>(externalShogiCpuJobKey);
        // 保存形式は維持し、局IDとrevisionで照合した局面のキーを補います。
        return job ? { ...job, positionKey: external.getPositionKey(state) } : null;
      },
      hasJob: () => this.storage.kv.get(externalShogiCpuJobKey) !== undefined,
      deleteJob: () => {
        this.storage.kv.delete(externalShogiCpuJobKey);
      },
      saveJob: ({ positionKey: _key, ...job }) => {
        this.storage.kv.put(externalShogiCpuJobKey, job);
      },
      matchesContext: (job) =>
        cpu?.kind === "cpu" &&
        cpu.level === 2 &&
        job.roundId === room.roundId &&
        job.positionRevision === room.positionRevision,
      sameRequest: (current, job) =>
        current.roundId === job.roundId && current.positionRevision === job.positionRevision,
      clockExpired: (now) => isClockExpired(room.clock, now),
      hasCpuJob: () => this.storage.kv.get(shogiCpuJobKey) !== undefined,
      saveAction: (_job, action, now, external) => this.saveAction(room, action, external, now),
    };
  }

  externalCpuJob(room: Playing): ShogiAiWork["job"] | undefined {
    const job = currentExternalCpuJob(this.runtime(room));
    if (!job) return undefined;
    const { positionKey: _key, ...saved } = job;
    return saved;
  }

  private requestOptions(room: Playing) {
    const rating = this.storage.kv.get<ActiveShogiMatch>(standardShogiMatchStartKey)?.start.rating;
    const profile =
      room.matchmaking && rating?.kind === "cpu" ? shogiCpuProfile(rating.profileId) : undefined;
    if (room.matchmaking && !profile) return null;
    const { state } = this.store().loadTransition(room.roundId, room.game);
    if (declarationStatus(state, room.game.turn).outcome === "win" || state.moveNumber > 1024)
      return null;
    const moves: string[] = [];
    for (let cursor = 0; ; cursor += 100) {
      const events = this.store().replayEvents(room.roundId, cursor);
      for (const event of events) if (event.type === "action") moves.push(usiMove(event.action));
      if (events.length < 100) break;
    }
    return moves.length === state.moveNumber ? { moves, ...profile } : null;
  }

  prepareExternalCpu(room: Playing, now: number, timeout: number): ShogiAiWork | null {
    const cpu = room.players.find((p) => p.side === room.game.turn);
    if (cpu?.kind !== "cpu" || cpu.level !== 2 || this.storage.kv.get(shogiCpuJobKey)) return null;
    const options = this.requestOptions(room);
    const job = prepareExternalCpu<ShogiTypes, Pick<Job, "roundId" | "positionRevision">>(
      this.runtime(room),
      options ? { roundId: room.roundId, positionRevision: room.positionRevision } : null,
      now,
      Math.min(now + timeout, room.clock.turnExpiresAt),
    );
    if (!job || !options) return null;
    const { positionKey: _key, ...saved } = job;
    return { job: saved, ...options };
  }

  completeExternalCpu(room: Playing, work: ShogiAiWork, move: string | null, now: number) {
    const runtime = this.runtime(room);
    completeExternalCpu(
      runtime,
      { ...work.job, positionKey: external.getPositionKey(runtime.state) },
      move,
      now,
    );
  }
}
