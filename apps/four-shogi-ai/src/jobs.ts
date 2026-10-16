import type { AiJobRequest, AiJobSnapshot } from "@tetraboard/protocol/four-shogi-ai";
import { aiRequestWindowMs } from "@tetraboard/protocol/four-shogi-ai";
import type { ServiceConfig } from "./config";

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}
export type Computed = {
  result: unknown;
  restoreMs: number;
  searchMs: number;
  inferenceMs: number;
};
export interface JobExecutor {
  ready(slot: number): boolean;
  run(
    slot: number,
    jobId: string,
    request: AiJobRequest,
    budgetMs: number,
    done: (value: Computed | null, error?: string) => void,
  ): void;
  cancel(slot: number, jobId: string): void;
  kill(slot: number): void;
  close(): Promise<void>;
}
type Job = {
  request: AiJobRequest;
  fingerprint: string;
  snapshot: AiJobSnapshot;
  accepted: number;
  started: number | null;
  deadline: number;
  hardAt: number | null;
  finished: number | null;
  slot: number | null;
  cancelledAt: number | null;
};
type Usage = {
  start: number;
  cpuCount: number;
  analysisCount: number;
  cpuMs: number;
  analysisMs: number;
};
export class JobManager {
  private jobs = new Map<string, Job>();
  private requests = new Map<string, string>();
  private usage = new Map<string, Usage>();
  private slots: (string | null)[];
  private stopping = false;
  private resourceBlocked = false;
  private observedBytes = 0;
  private peakBytes = 0;
  constructor(
    readonly config: ServiceConfig,
    readonly executor: JobExecutor,
    readonly instanceId: string,
    private now = () => performance.now(),
    private id: () => string = () => crypto.randomUUID(),
    private log: (entry: object) => void = () => {},
  ) {
    this.slots = Array(config.workers).fill(null);
  }
  health() {
    return {
      schemaVersion: 1,
      serviceInstanceId: this.instanceId,
      requestWindow: Math.floor(this.now() / aiRequestWindowMs),
      codeVersion: this.config.codeVersion,
      engineVersion: "tetraboard-four-shogi-rules-v1",
      modelId: this.config.modelId,
      status: this.stopping
        ? "stopping"
        : !this.resourceBlocked && this.slots.every((_, i) => this.executor.ready(i))
          ? "ready"
          : "unavailable",
      workers: this.slots.length,
      running: this.slots.filter(Boolean).length,
      queued: [...this.jobs.values()].filter((j) => j.snapshot.status === "queued").length,
      cpuReserved: this.config.cpuReserved,
      memory: {
        observedBytes: this.observedBytes,
        peakBytes: this.peakBytes,
        limitBytes: this.config.maxRssBytes,
      },
    };
  }
  observeMemory(bytes: number) {
    this.observedBytes = bytes;
    this.peakBytes = Math.max(this.peakBytes, bytes);
  }
  private epoch(instance: string) {
    if (instance !== this.instanceId) throw new ServiceError("service_restarted", 410);
  }
  submit(request: AiJobRequest, fingerprint: string): AiJobSnapshot {
    this.tick();
    this.epoch(request.serviceInstanceId);
    if (this.stopping) throw new ServiceError("shutting_down", 503);
    if (request.codeVersion !== this.config.codeVersion)
      throw new ServiceError("code_mismatch", 409);
    if (request.modelId !== null && request.modelId !== this.config.modelId)
      throw new ServiceError("model_mismatch", 409);
    const key = request.principal + ":" + request.requestId;
    const previous = this.requests.get(key);
    if (previous) {
      const job = this.jobs.get(previous)!;
      if (job.fingerprint !== fingerprint) throw new ServiceError("request_conflict", 409);
      return structuredClone(job.snapshot);
    }
    const age =
      Math.floor(this.now() / aiRequestWindowMs) - Number(request.requestId.split(":")[0]);
    if (!Number.isSafeInteger(age) || age < 0 || age > 1)
      throw new ServiceError("request_expired", 410);
    if (request.lifetimeMs === 0) throw new ServiceError("expired", 410);
    if (this.health().status !== "ready") throw new ServiceError("unavailable", 503);
    const purpose = request.context.kind;
    if (
      request.position.events.length > this.config.maxEvents ||
      request.budget.timeBudgetMs >
        (purpose === "cpu" ? this.config.maxCpuMs : this.config.maxAnalysisMs) ||
      request.budget.maxWork >
        (purpose === "cpu" ? this.config.maxCpuWork : this.config.maxAnalysisWork)
    )
      throw new ServiceError("budget_limit", 400);
    const at = this.now();
    const usage = this.usage.get(request.principal) ?? {
      start: at,
      cpuCount: 0,
      analysisCount: 0,
      cpuMs: 0,
      analysisMs: 0,
    };
    const used = purpose === "cpu" ? usage.cpuCount : usage.analysisCount;
    const ms = purpose === "cpu" ? usage.cpuMs : usage.analysisMs;
    if (
      used >= (purpose === "cpu" ? this.config.cpuRequests : this.config.analysisRequests) ||
      ms + request.budget.timeBudgetMs >
        (purpose === "cpu" ? this.config.cpuBudgetMs : this.config.analysisBudgetMs)
    )
      throw new ServiceError(
        "usage_limit",
        429,
        Math.max(1, usage.start + this.config.quotaWindowMs - at),
      );
    if (!this.usage.has(request.principal) && this.usage.size >= this.config.maxPrincipals)
      throw new ServiceError("principal_limit", 503);
    const pending = [...this.jobs.values()].filter((j) =>
      ["queued", "running"].includes(j.snapshot.status),
    );
    if (
      pending.filter((j) => j.request.principal === request.principal).length >=
      this.config.maxPendingPerPrincipal
    )
      throw new ServiceError("pending_limit", 429, 1000);
    if (this.jobs.size >= this.config.maxJobs) throw new ServiceError("job_capacity", 503);
    if (
      pending.filter((j) => j.snapshot.status === "queued" && j.request.context.kind === purpose)
        .length >= (purpose === "cpu" ? this.config.maxQueueCpu : this.config.maxQueueAnalysis)
    )
      throw new ServiceError("queue_full", 503);
    const jobId = this.id();
    const snapshot: AiJobSnapshot = {
      schemaVersion: 1,
      serviceInstanceId: this.instanceId,
      jobId,
      requestId: request.requestId,
      stateHash: request.stateHash,
      inputHash: fingerprint,
      codeVersion: this.config.codeVersion,
      engineVersion: request.engineVersion,
      modelId: request.modelId,
      context: structuredClone(request.context),
      status: "queued",
      error: null,
      timing: { queueMs: 0, computeMs: 0, restoreMs: 0, searchMs: 0, inferenceMs: 0 },
      result: null,
    };
    this.jobs.set(jobId, {
      request: structuredClone(request),
      fingerprint,
      snapshot,
      accepted: at,
      started: null,
      deadline: at + request.lifetimeMs,
      hardAt: null,
      finished: null,
      slot: null,
      cancelledAt: null,
    });
    this.requests.set(key, jobId);
    if (purpose === "cpu") {
      usage.cpuCount++;
      usage.cpuMs += request.budget.timeBudgetMs;
    } else {
      usage.analysisCount++;
      usage.analysisMs += request.budget.timeBudgetMs;
    }
    this.usage.set(request.principal, usage);
    this.log({ event: "job_accepted", jobId, requestId: request.requestId, purpose });
    this.dispatch();
    return structuredClone(snapshot);
  }
  get(jobId: string, principal: string, instance: string) {
    this.epoch(instance);
    const job = this.jobs.get(jobId);
    if (!job || job.request.principal !== principal) throw new ServiceError("job_not_found", 404);
    return structuredClone(job.snapshot);
  }
  cancel(jobId: string, principal: string, instance: string) {
    this.get(jobId, principal, instance);
    const job = this.jobs.get(jobId)!;
    if (["queued", "running"].includes(job.snapshot.status))
      this.finish(job, "cancelled", "cancelled");
    this.dispatch();
    return this.get(jobId, principal, instance);
  }
  private finish(job: Job, status: "cancelled" | "expired" | "failed", error: string) {
    job.snapshot.status = status;
    job.snapshot.error = error;
    job.snapshot.result = null;
    job.finished = this.now();
    if (job.started === null)
      job.snapshot.timing.queueMs = Math.max(0, job.finished - job.accepted);
    else job.snapshot.timing.computeMs = Math.max(0, job.finished - job.started);
    if (job.slot !== null) {
      job.cancelledAt = this.now();
      this.executor.cancel(job.slot, job.snapshot.jobId);
    }
  }
  private dispatch() {
    if (this.stopping || this.resourceBlocked) return;
    for (let slot = 0; slot < this.slots.length; slot++) {
      if (this.slots[slot] !== null || !this.executor.ready(slot)) continue;
      const queued = [...this.jobs.values()].filter(
        (j) =>
          j.snapshot.status === "queued" &&
          (slot >= this.config.cpuReserved || j.request.context.kind === "cpu"),
      );
      const job = queued.find((j) => j.request.context.kind === "cpu") ?? queued[0];
      if (!job) continue;
      const started = this.now(),
        budgetMs = Math.min(job.request.budget.timeBudgetMs, job.deadline - started);
      if (budgetMs <= 0) {
        this.finish(job, "expired", "expired");
        continue;
      }
      const jobId = job.snapshot.jobId;
      job.started = started;
      job.slot = slot;
      job.hardAt = Math.min(job.deadline, started + budgetMs + this.config.cancelGraceMs);
      job.snapshot.status = "running";
      job.snapshot.timing.queueMs = Math.max(0, started - job.accepted);
      this.slots[slot] = jobId;
      try {
        this.executor.run(slot, jobId, job.request, budgetMs, (value, error) => {
          if (this.slots[slot] !== jobId || job.slot !== slot) return;
          this.slots[slot] = null;
          job.slot = null;
          const at = this.now();
          job.snapshot.timing.computeMs = Math.max(0, at - started);
          if (job.snapshot.status === "running") {
            if (at >= job.deadline || at > job.hardAt!) this.finish(job, "expired", "expired");
            else if (!value || error) this.finish(job, "failed", error ?? "compute_failed");
            else if (
              new TextEncoder().encode(JSON.stringify(value.result)).length >
              this.config.maxResultBytes
            )
              this.finish(job, "failed", "result_size_limit");
            else {
              job.snapshot.status = "completed";
              job.snapshot.result = structuredClone(value.result);
              Object.assign(job.snapshot.timing, {
                restoreMs: value.restoreMs,
                searchMs: value.searchMs,
                inferenceMs: value.inferenceMs,
              });
              job.finished = at;
            }
          }
          this.log({
            event: "job_finished",
            jobId,
            requestId: job.request.requestId,
            purpose: job.request.context.kind,
            status: job.snapshot.status,
            error: job.snapshot.error,
            timing: job.snapshot.timing,
          });
          this.dispatch();
        });
      } catch {
        this.slots[slot] = null;
        job.slot = null;
        this.finish(job, "failed", "compute_unavailable");
      }
    }
  }
  tick() {
    const at = this.now();
    for (const [principal, value] of this.usage)
      if (at >= value.start + this.config.quotaWindowMs) this.usage.delete(principal);
    for (const [jobId, job] of this.jobs) {
      if (
        job.snapshot.status === "queued" &&
        (at >= job.deadline || at - job.accepted >= this.config.maxQueueMs)
      )
        this.finish(job, "expired", "queue_deadline");
      if (job.snapshot.status === "running" && at >= job.hardAt!)
        this.finish(job, "expired", "compute_deadline");
      if (
        job.slot !== null &&
        job.cancelledAt !== null &&
        at - job.cancelledAt >= this.config.cancelGraceMs
      ) {
        const slot = job.slot;
        this.slots[slot] = null;
        job.slot = null;
        this.executor.kill(slot);
      }
      if (
        job.finished !== null &&
        job.slot === null &&
        at - job.finished >= this.config.resultTtlMs
      ) {
        this.jobs.delete(jobId);
        this.requests.delete(job.request.principal + ":" + job.request.requestId);
      }
    }
    this.dispatch();
  }
  async shutdown() {
    this.stopAccepting();
    for (const job of this.jobs.values())
      if (["queued", "running"].includes(job.snapshot.status))
        this.finish(job, "cancelled", "shutdown");
    await this.executor.close();
  }
  stopAccepting() {
    this.stopping = true;
  }
  resourceLimit() {
    this.resourceBlocked = true;
    for (const job of this.jobs.values())
      if (["queued", "running"].includes(job.snapshot.status))
        this.finish(job, "failed", "memory_limit");
    void this.executor.close().catch(() => {});
    for (let slot = 0; slot < this.slots.length; slot++) {
      const id = this.slots[slot];
      if (id) this.jobs.get(id)!.slot = null;
      this.slots[slot] = null;
      this.executor.kill(slot);
    }
  }
}
