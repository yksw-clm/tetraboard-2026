import type { GameDefinition, GameTypes } from "@tetraboard/game-contract";

export type ExternalCpuJob = { requestId: string; expiresAt: number; positionKey: string };
export interface ExternalCpuRuntime<T extends GameTypes, Job extends ExternalCpuJob> {
  definition: GameDefinition<T, string>;
  state: T["state"];
  seat: T["seat"];
  level: T["cpuLevel"];
  random?: () => number;
  history?: T["history"];
  loadJob: () => Job | null;
  hasJob: () => boolean;
  deleteJob: () => void;
  saveJob: (job: Job) => void;
  matchesContext: (job: Job) => boolean;
  sameRequest: (current: Job, received: Job) => boolean;
  clockExpired: (now: number) => boolean;
  hasCpuJob: () => boolean;
  saveAction: (job: Job, action: T["action"], now: number, external: boolean) => void;
}

export function currentExternalCpuJob<T extends GameTypes, Job extends ExternalCpuJob>(
  runtime: ExternalCpuRuntime<T, Job>,
): Job | null {
  const job = runtime.loadJob();
  return job &&
    runtime.matchesContext(job) &&
    job.positionKey === runtime.definition.cpu.external?.getPositionKey(runtime.state)
    ? job
    : null;
}

export function prepareExternalCpu<T extends GameTypes, Context extends object>(
  runtime: ExternalCpuRuntime<T, Context & ExternalCpuJob>,
  context: Context | null,
  now: number,
  expiresAt: number,
): (Context & ExternalCpuJob) | null {
  const external = runtime.definition.cpu.external;
  if (!external || runtime.clockExpired(now)) return null;
  if (runtime.hasJob()) {
    const current = currentExternalCpuJob(runtime);
    if (!current) runtime.deleteJob();
    else if (current.expiresAt <= now) completeExternalCpu(runtime, current, null, now);
    return null;
  }
  if (context === null) return null;
  const job = {
    ...context,
    positionKey: external.getPositionKey(runtime.state),
    requestId: crypto.randomUUID(),
    expiresAt,
  };
  runtime.saveJob(job);
  return job;
}

export function completeExternalCpu<T extends GameTypes, Job extends ExternalCpuJob>(
  runtime: ExternalCpuRuntime<T, Job>,
  job: Job,
  move: T["externalMove"] | null,
  now: number,
): boolean {
  const external = runtime.definition.cpu.external;
  const current = currentExternalCpuJob(runtime);
  if (
    !external ||
    !current ||
    current.requestId !== job.requestId ||
    !runtime.sameRequest(current, job) ||
    !runtime.matchesContext(job) ||
    job.positionKey !== external.getPositionKey(runtime.state) ||
    runtime.clockExpired(now) ||
    runtime.hasCpuJob()
  )
    return false;
  const proposed = move === null || now >= job.expiresAt ? null : external.readMove(move);
  const legal =
    proposed !== null &&
    runtime.definition.rules.applyAction(runtime.state, runtime.seat, proposed, runtime.history).ok;
  const action = legal
    ? proposed
    : external.fallbackAction
      ? external.fallbackAction(runtime.state, runtime.seat)
      : runtime.definition.cpu.chooseAction(
          runtime.state,
          runtime.seat,
          runtime.level,
          runtime.random ?? Math.random,
          runtime.history,
        );
  if (action === null) return false;
  runtime.saveAction(job, action, now, legal);
  runtime.deleteJob();
  return true;
}
