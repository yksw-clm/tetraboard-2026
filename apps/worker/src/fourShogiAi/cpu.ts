import {
  fourShogiActionSchema,
  isFourShogiRoom,
  type FourShogiRoom,
  type Room,
} from "@tetraboard/protocol";
import {
  aiCpuProfiles,
  aiJobRequestSchema,
  aiRequestFingerprint,
  createAiRequestId,
  type AiCpuProfile,
  type AiJobRequest,
  type AiJobSnapshot,
} from "@tetraboard/protocol/four-shogi-ai";
import { chooseCpuAction, type FourShogiAction } from "@tetraboard/four-shogi";
import { getAnalysisStateHash } from "@tetraboard/four-shogi/analysis";
import {
  aiHealth,
  aiPrincipal,
  fetchAiService,
  gatewayConfig,
  submitAiJob,
  validatedSnapshot,
  AiGatewayError,
  type AiGatewayEnv,
} from "./client";
import type { FourShogiProgress } from "../rooms/fourShogiProgress";
import { cpuMoveDelayMs } from "../rooms/progressHelpers";

type Playing = Extract<FourShogiRoom, { status: "playing" }>;
export const trialCpuSettingsKey = "four-shogi-trial-cpu-settings";
export const trialCpuJobKey = "four-shogi-trial-cpu-job";
export const trialCpuDiagnosticsKey = "four-shogi-trial-cpu-diagnostics";
export type TrialCpuSettings = {
  instanceId: string;
  ownerId: string;
  players: Record<string, AiCpuProfile>;
};
type Job = {
  id: string;
  instanceId: string;
  roundId: string;
  revision: number;
  side: Playing["game"]["turn"];
  playerId: string;
  level: 2;
  ownerId: string;
  profile: AiCpuProfile;
  startedAt: number;
  turnStartedAt: number;
  deadlineAt: number;
  fallbackAt: number;
  nextAt: number;
  codeVersion: string;
  modelId: string;
  backup: FourShogiAction;
  action: FourShogiAction | null;
  source: "model" | "terminal" | "lv2" | "legal" | null;
  reason: string | null;
  coreStamp: string;
  eventCount: number;
  stateHash: string | null;
  request: AiJobRequest | null;
  inputHash: string | null;
  snapshot: AiJobSnapshot | null;
};
type Dependencies = {
  storage: DurableObjectStorage;
  env: AiGatewayEnv;
  progress: FourShogiProgress;
  readRoom: () => Room | null;
  accountId: (playerId: string) => string | null;
  changed: () => Promise<void>;
  waitUntil: (promise: Promise<unknown>) => void;
};
export class FourShogiTrialCpu {
  private active: { id: string; abort: AbortController } | null = null;
  constructor(private readonly deps: Dependencies) {}
  private get storage() {
    return this.deps.storage;
  }
  private settings(room: Room | null) {
    if (!room || !isFourShogiRoom(room) || room.settings.mode !== "singles") return null;
    const saved = this.storage.kv.get<TrialCpuSettings>(trialCpuSettingsKey);
    if (!saved || saved.instanceId !== room.instanceId) return null;
    try {
      const config = gatewayConfig(this.deps.env);
      if (
        !config.ids.includes(saved.ownerId) ||
        !room.players.some(
          (p) => p.kind === "human" && this.deps.accountId(p.id) === saved.ownerId,
        ) ||
        !room.players.every(
          (p) => p.kind === "cpu" || config.ids.includes(this.deps.accountId(p.id) ?? ""),
        )
      )
        return null;
      return saved;
    } catch {
      return null;
    }
  }
  enabled(room: Playing) {
    const cpu = room.players.find((p) => p.side === room.game.turn);
    const settings = this.settings(room);
    return cpu?.kind === "cpu" && cpu.level === 2 && settings?.players[cpu.id]
      ? { cpu, settings, profile: settings.players[cpu.id] }
      : null;
  }
  private matches(job: Job, room = this.deps.readRoom()): room is Playing {
    if (!room || !isFourShogiRoom(room) || room.status !== "playing") return false;
    const enabled = this.enabled(room);
    return (
      !!enabled &&
      job.instanceId === room.instanceId &&
      job.roundId === room.roundId &&
      job.revision === room.positionRevision &&
      job.coreStamp === JSON.stringify(room.game) &&
      job.eventCount === this.deps.progress.store().eventCount(room.roundId) &&
      job.side === room.game.turn &&
      !room.game.eliminations.some((e) => e.side === job.side) &&
      enabled.cpu.id === job.playerId &&
      enabled.cpu.level === job.level &&
      enabled.profile === job.profile &&
      enabled.settings.ownerId === job.ownerId &&
      room.clock.turnStartedAt === job.turnStartedAt &&
      room.clock.turnExpiresAt === job.deadlineAt &&
      this.deps.env.FOUR_SHOGI_AI_CODE_VERSION === job.codeVersion &&
      this.deps.env.FOUR_SHOGI_AI_MODEL_ID === job.modelId
    );
  }
  private current(id: string) {
    const job = this.storage.kv.get<Job>(trialCpuJobKey);
    return job?.id === id && this.matches(job) ? job : null;
  }
  private cancel(job: Job) {
    if (this.active?.id === job.id) this.active.abort.abort();
    if (job.snapshot && job.request)
      this.deps.waitUntil(
        fetchAiService(
          this.deps.env,
          "/v1/jobs/" + job.snapshot.jobId,
          { method: "DELETE" },
          job.request.principal,
          job.request.serviceInstanceId,
        ).catch(() => undefined),
      );
  }
  maintain(room: Room | null) {
    const settings = this.storage.kv.get<TrialCpuSettings>(trialCpuSettingsKey);
    if (settings) {
      if (!this.settings(room)) this.storage.kv.delete(trialCpuSettingsKey);
      else if (room) {
        const players = Object.fromEntries(
          Object.entries(settings.players).filter(([id]) =>
            room.players.some(
              (player) => player.kind === "cpu" && player.level === 2 && player.id === id,
            ),
          ),
        );
        if (Object.keys(players).length !== Object.keys(settings.players).length)
          this.storage.kv.put(trialCpuSettingsKey, { ...settings, players });
      }
    }
    const job = this.storage.kv.get<Job>(trialCpuJobKey);
    if (job && !this.matches(job, room)) {
      this.storage.kv.delete(trialCpuJobKey);
      this.cancel(job);
      this.record(job, "discarded", "stale_context");
    }
    if (!room) this.storage.kv.delete(trialCpuDiagnosticsKey);
  }
  alarmAt(room: Room) {
    this.maintain(room);
    const job = this.storage.kv.get<Job>(trialCpuJobKey);
    return job ? Math.min(job.nextAt, job.action ? job.nextAt : job.fallbackAt) : null;
  }
  private record(job: Job, outcome: "applied" | "discarded", reason = job.reason) {
    const entries = this.storage.kv.get<object[]>(trialCpuDiagnosticsKey) ?? [];
    const result = job.snapshot?.result as {
      model?: { usedModelId?: string; inferenceCount?: number };
    } | null;
    this.storage.kv.put(trialCpuDiagnosticsKey, [
      ...entries.slice(-31),
      {
        requestId: job.request?.requestId ?? null,
        jobId: job.snapshot?.jobId ?? null,
        instanceId: job.instanceId,
        roundId: job.roundId,
        revision: job.revision,
        side: job.side,
        profile: job.profile,
        budget: aiCpuProfiles[job.profile],
        codeVersion: job.codeVersion,
        requestedModelId: job.modelId,
        usedModelId: job.source === "model" ? (result?.model?.usedModelId ?? null) : null,
        inferenceCount: job.source === "model" ? (result?.model?.inferenceCount ?? 0) : 0,
        stateHash: job.stateHash,
        source: job.source,
        reason,
        outcome,
        elapsedMs: Math.max(0, Date.now() - job.startedAt),
        timing: job.snapshot?.timing ?? null,
      },
    ]);
  }
  cpu(room: Playing, now: number) {
    const enabled = this.enabled(room);
    if (!enabled) return null;
    this.maintain(room);
    let job = this.storage.kv.get<Job>(trialCpuJobKey);
    if (!job) {
      const config = gatewayConfig(this.deps.env);
      const backup = room.legalActions[0];
      if (!backup) throw new Error("Trial CPU has no legal action");
      job = {
        id: crypto.randomUUID(),
        instanceId: room.instanceId,
        roundId: room.roundId,
        revision: room.positionRevision,
        side: room.game.turn,
        playerId: enabled.cpu.id,
        level: 2,
        ownerId: enabled.settings.ownerId,
        profile: enabled.profile,
        startedAt: now,
        turnStartedAt: room.clock.turnStartedAt,
        deadlineAt: room.clock.turnExpiresAt,
        fallbackAt: Math.min(now + 2000, room.clock.turnExpiresAt - 100),
        nextAt: now,
        codeVersion: config.codeVersion,
        modelId: config.modelId,
        backup,
        action: null,
        source: null,
        reason: null,
        coreStamp: JSON.stringify(room.game),
        eventCount: this.deps.progress.store().eventCount(room.roundId),
        stateHash: null,
        request: null,
        inputHash: null,
        snapshot: null,
      };
      this.storage.kv.put(trialCpuJobKey, job);
    }
    if (!job.action && (job.reason || now >= job.fallbackAt)) {
      this.cancel(job);
      let action: FourShogiAction | null = null;
      if (job.deadlineAt - Date.now() > 100) {
        const { state, repetitionLookup } = this.deps.progress
          .store()
          .loadTransition(room.roundId, room.game);
        try {
          action = chooseCpuAction(state, 2, Math.random, repetitionLookup);
        } catch {
          /* 予備の合法手を使います。 */
        }
      }
      job.action = action ?? job.backup;
      job.source = action ? "lv2" : "legal";
      job.reason ??= "response_timeout";
      job.nextAt = Date.now() + 1;
      this.storage.kv.put(trialCpuJobKey, job);
      return null;
    }
    if (
      job.action &&
      job.nextAt <= now &&
      now >= room.clock.turnStartedAt + cpuMoveDelayMs &&
      now < room.clock.turnExpiresAt
    ) {
      const result = this.deps.progress.cpuAction(
        room,
        job.action,
        Date.now(),
        job.source === "terminal",
      );
      if (result.kind === "rejected") {
        job.action = null;
        job.source = null;
        job.reason = "illegal_action";
        job.nextAt = now + 1;
        this.storage.kv.put(trialCpuJobKey, job);
        return null;
      }
      this.storage.kv.delete(trialCpuJobKey);
      this.record(job, "applied");
      return result;
    }
    return null;
  }
  kick() {
    const job = this.storage.kv.get<Job>(trialCpuJobKey);
    if (
      !job ||
      job.action ||
      job.reason ||
      !this.matches(job) ||
      job.nextAt > Date.now() ||
      this.active
    )
      return;
    const abort = new AbortController();
    this.active = { id: job.id, abort };
    job.nextAt = job.fallbackAt;
    this.storage.kv.put(trialCpuJobKey, job);
    this.deps.waitUntil(this.deps.changed());
    this.deps.waitUntil(
      this.run(job, abort.signal)
        .catch((error) => {
          const current = this.current(job.id);
          if (current && !current.action) {
            current.reason =
              Date.now() >= current.fallbackAt
                ? "response_timeout"
                : error instanceof AiGatewayError
                  ? error.code
                  : "ai_response_mismatch";
            current.nextAt = Date.now() + 1;
            this.storage.kv.put(trialCpuJobKey, current);
          }
        })
        .finally(async () => {
          if (this.active?.id === job.id) this.active = null;
          await this.deps.changed();
        }),
    );
  }
  private async run(job: Job, aborted: AbortSignal) {
    const remaining = job.fallbackAt - Date.now();
    if (remaining <= 0) return;
    const signal = AbortSignal.any([aborted, AbortSignal.timeout(remaining)]);
    if (!job.request) {
      const room = this.deps.readRoom();
      if (!this.matches(job, room) || !room || !isFourShogiRoom(room) || room.status !== "playing")
        return;
      const store = this.deps.progress.store(),
        count = store.eventCount(room.roundId);
      if (count > 2048) throw new AiGatewayError("history_limit", 413);
      const stateHash = await getAnalysisStateHash(store.loadState(room.roundId, room.game));
      if (!this.current(job.id) || signal.aborted) return;
      const events = [];
      for (let offset = 0; offset < count;) {
        const page = store.getPage(room.instanceId, room.roundId, offset);
        if (!page?.events.length) throw new Error("Incomplete replay");
        events.push(...page.events);
        offset += page.events.length;
      }
      const health = await aiHealth(this.deps.env, signal);
      const principal = await aiPrincipal(this.deps.env, job.ownerId);
      if (!this.current(job.id) || signal.aborted) return;
      job.stateHash = stateHash;
      job.request = aiJobRequestSchema.parse({
        schemaVersion: 1,
        serviceInstanceId: health.serviceInstanceId,
        requestId: createAiRequestId(health.requestWindow),
        principal,
        codeVersion: job.codeVersion,
        engineVersion: health.engineVersion,
        modelId: job.modelId,
        stateHash,
        context: {
          kind: "cpu",
          roomId: room.id,
          instanceId: room.instanceId,
          matchId: room.roundId,
          revision: room.positionRevision,
          side: room.game.turn,
          deadlineAtMs: room.clock.turnExpiresAt,
        },
        lifetimeMs: Math.max(1, Math.min(90000, job.fallbackAt - Date.now())),
        budget: aiCpuProfiles[job.profile],
        position: {
          schemaVersion: 1,
          rulesVersion: 1,
          ruleProfileId: "tetraboard-four-shogi-singles-v1",
          initial: {
            ...store.replayInfo(room.roundId),
            players: { south: "south", west: "west", north: "north", east: "east" },
          },
          events,
          eventOffset: count,
        },
      });
      job.inputHash = await aiRequestFingerprint(job.request);
      if (!this.current(job.id) || signal.aborted) return;
      this.storage.kv.put(trialCpuJobKey, job);
    }
    const request = job.request;
    let snapshot: AiJobSnapshot;
    if (job.snapshot) {
      const response = await fetchAiService(
        this.deps.env,
        "/v1/jobs/" + job.snapshot.jobId,
        { signal },
        request.principal,
        request.serviceInstanceId,
      );
      snapshot = validatedSnapshot(this.deps.env, response.data, request.serviceInstanceId);
      if (snapshot.jobId !== job.snapshot.jobId)
        throw new AiGatewayError("ai_response_mismatch", 503);
    } else snapshot = (await submitAiJob(this.deps.env, request, signal)).snapshot;
    if (!this.current(job.id) || signal.aborted || Date.now() >= job.fallbackAt) {
      this.cancel({ ...job, snapshot });
      return;
    }
    if (
      snapshot.requestId !== request.requestId ||
      snapshot.inputHash !== job.inputHash ||
      snapshot.stateHash !== job.stateHash ||
      JSON.stringify(snapshot.context) !== JSON.stringify(request.context)
    )
      throw new AiGatewayError("ai_response_mismatch", 503);
    job.snapshot = snapshot;
    job.nextAt = Date.now() + 100;
    if (snapshot.status === "completed") {
      const result = snapshot.result as {
        input?: {
          rootSide?: string;
          eventOffset?: number;
          rulesVersion?: number;
          threePlayerAttackProhibited?: boolean;
        };
        model?: {
          requestedModelId?: string;
          usedModelId?: string;
          inferenceCount?: number;
          fallbackReason?: string;
        };
        evaluation?: { evaluationKind?: string };
        versions?: { engineVersion?: string };
        recommendedAction?: unknown;
      };
      const action = fourShogiActionSchema.safeParse(result.recommendedAction);
      const terminal = result.evaluation?.evaluationKind === "terminal";
      if (
        !action.success ||
        result.input?.rootSide !== job.side ||
        result.input?.eventOffset !== request.position.eventOffset ||
        result.input?.rulesVersion !== 1 ||
        result.input?.threePlayerAttackProhibited !==
          request.position.initial.threePlayerAttackProhibited ||
        result.model?.requestedModelId !== job.modelId ||
        result.versions?.engineVersion !== request.engineVersion ||
        (!terminal &&
          (result.model?.usedModelId !== job.modelId ||
            !Number.isSafeInteger(result.model?.inferenceCount) ||
            result.model!.inferenceCount! <= 0)) ||
        result.model?.fallbackReason
      )
        throw new AiGatewayError("model_not_used", 503);
      const room = this.deps.readRoom();
      if (!this.matches(job, room) || !room || !isFourShogiRoom(room) || room.status !== "playing")
        return;
      const hash = await getAnalysisStateHash(
        this.deps.progress.store().loadState(room.roundId, room.game),
      );
      if (!this.current(job.id) || signal.aborted || Date.now() >= job.fallbackAt) return;
      if (hash !== job.stateHash) throw new AiGatewayError("state_mismatch", 503);
      job.action = action.data;
      job.source = terminal ? "terminal" : "model";
      job.nextAt = Date.now() + 1;
    } else if (snapshot.status !== "queued" && snapshot.status !== "running") {
      job.reason = snapshot.error ?? snapshot.status;
      job.nextAt = Date.now() + 1;
    }
    if (this.current(job.id)?.action) return;
    this.storage.kv.put(trialCpuJobKey, job);
  }
}
