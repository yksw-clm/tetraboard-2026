import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  compareStudyCandidates,
  evaluateStudyPosition,
  selectStudyRootIndices,
  selectStudyIterationRoots,
  isDualStudyStrategy,
  studyStrategyVersion,
  legacyStudySearchVersion,
  type StudyCandidate,
  type StudySplitPlan,
  type StudySubtreeResult,
  type StudySubtreeTask,
  type StudyLaneSnapshot,
  type StudyProfile,
  type StudySearchPerformance,
  type StudySearchStrategy,
} from "@tetraboard/four-shogi/study-search";
import type { AiCandidate, AiEvaluation, AiLineStep } from "@tetraboard/four-shogi/ai";
import type { FourShogiAction, Side } from "@tetraboard/four-shogi";
import { getAnalysisLegalActions, type AnalysisPosition } from "@tetraboard/four-shogi/analysis";
import { restoreStudyPosition } from "../domain/study";
import type { StudyPositionInput, StudySearchCoverage } from "../shared/model";
import type { SearchCommand, SearchMessage } from "./messages";
import { projectFocusPosition, type FocusProjection } from "./focus";

export type StudyFocusMetadata = {
  side: Side;
  status: FocusProjection["status"] | "preparing" | "error";
  reason: string | null;
  sourceStateHash: string;
  analysisStateHash: string | null;
  prefix: readonly AiLineStep[];
  conditional: boolean;
  projectionElapsedMs: number;
  model: FocusProjection["model"] | null;
  result: FocusProjection["result"];
};

export type StudySearchSnapshot = {
  timing?: {
    restoreMs: number;
    startupMs: number;
    parentEvaluationMs: number;
    parentLegalMs: number;
    preSearchMs: number;
    firstWorkerMs: number | null;
    depthOneMs: number | null;
    depthTwoMs: number | null;
    deepStartedMs: number | null;
    splitPlans?: number;
    subtreeTasksAssigned?: number;
    subtreeTasksCompleted?: number;
    pendingRoots?: number;
    queuedSubtrees?: number;
    tasksAssigned: number;
    tasksCompleted: number;
    deepTasksAssigned: number;
    incompleteTasks: number;
    queuedTasks: number;
    ipcCommands: number;
    ipcMessages: number;
    workers: ({ restoreMs: number; createMs: number; activeMs: number; cpuMs: number } | null)[];
  };
  coverage?: StudySearchCoverage;
  broadCandidates?: readonly AiCandidate[];
  id: string;
  stateHash: string;
  analysisStateHash: string | null;
  focus: StudyFocusMetadata | null;
  rootSide: Side | null;
  status: "running" | "paused" | "completed" | "cancelled" | "error";
  reason: string | null;
  elapsedMs: number;
  completedDepth: number;
  work: number;
  nodes: number;
  memoryBytes: number;
  candidates: readonly AiCandidate[];
  recommendedAction: FourShogiAction | null;
  analysisRecommendedAction: FourShogiAction | null;
  evaluation: AiEvaluation | null;
  staticEvaluation: AiEvaluation;
  workers: number;
  performance?: StudySearchPerformance & {
    legalCacheHits: number;
    generatedMoves?: number;
    transitionCacheHits: number;
    evaluationCacheHits: number;
    iterationDepth: number;
    completedIterationWork?: number;
    completedTasks: number;
    totalTasks: number;
    workerNodes: number[];
    workerWaitMs: number[];
    depths: { depth: number; elapsedMs: number; roots: number }[];
  };
  diagnostics: {
    searchVersion: string;
    profile: StudyProfile;
    selectedRoots: number;
    legalRoots: number;
    safetyComplete: boolean;
  };
};
export type StudySearchOptions = {
  reuseChecks?: boolean;
  strategy?: StudySearchStrategy;
  broadDepth?: number;
  timeBudgetMs: number | null;
  focusSide?: Side | null;
  maxDepth?: number;
  profile?: StudyProfile;
  width?: number;
  rootWidth?: number;
  extensions?: number;
  dangerWork?: number;
  cacheSize?: number;
};
export type StudyRuntimeTraceEvent =
  | { type: "command"; worker: number; command: SearchCommand }
  | { type: "message"; worker: number; message: SearchMessage }
  | { type: "iteration"; depth: number; phase: "broad" | "deep" | "adaptive"; roots: number[] }
  | {
      type: "publication";
      depth: number;
      published: boolean;
      candidates: StudyCandidate[];
      coverage: StudySearchCoverage | undefined;
    };

export type StudyParallelEvent =
  | {
      type: "iteration" | "iterationEnd";
      id: string;
      atMs: number;
      depth: number;
      phase: "broad" | "deep" | "adaptive";
      roots: number;
    }
  | {
      type: "assigned";
      id: string;
      atMs: number;
      worker: number;
      taskId: number;
      role?: "root" | "subtree" | "finish";
      index: number;
      depth: number;
      phase: "broad" | "deep" | "adaptive";
    }
  | {
      type: "worker";
      id: string;
      atMs: number;
      worker: number;
      taskId?: number;
      outcome?: "split" | "subtree";
      index?: number;
      depth: number;
      phase: "prepare" | "broad" | "deep" | "adaptive";
      barrier: boolean;
      accepted: boolean;
      work: number;
      nodes: number;
      rss: number;
      activeMs: number;
      cpuMs: number;
      restoreMs: number;
      createMs: number;
      taskInitMs?: number;
      taskInitCpuMs?: number;
      processCpuMs?: number;
      restoreCpuMs?: number;
      createCpuMs?: number;
      transport?: { sendCalls: number; jsonBytes: number; sendMs: number; sizingMs: number };
    }
  | {
      type: "ipc";
      id: string | null;
      atMs: number;
      worker: number;
      direction: "send" | "receive";
      jsonBytes: number;
      sizingMs: number;
      callMs: number;
    }
  | {
      type: "parent";
      id: string | null;
      atMs: number;
      operation: "dispatch" | "merge";
      wallMs: number;
      cpuMs: number;
    };

export type StudySearchRuntimeConfig = {
  reuseWorkers?: boolean;
  measureStages?: boolean;
  observeDiagnostic?: (event: StudyRuntimeTraceEvent) => void;
  observeParallel?: (event: StudyParallelEvent) => void;
  scheduling?: "fixed" | "dynamic";
  taskPartition?: "root" | "replies";
  threads?: number;
  memoryMb?: number;
  workerScript?: URL;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  cpuProfileDirectory?: string;
};
type Lane = {
  snapshot: StudyLaneSnapshot;
  memoryBytes: number;
  barrier: boolean;
  timing?: Extract<SearchMessage, { type: "progress" }>["timing"];
};
type Assignment = {
  index: number;
  taskId: number;
  kind?: "root" | "subtree" | "finish";
  planKey?: string;
  slot?: number;
};
type PendingRoot = {
  owner: number;
  index: number;
  plan: StudySplitPlan;
  results: Map<number, StudySubtreeResult>;
  finishing: boolean;
};
type Job = {
  dynamic: {
    dual?: {
      phase: "broad" | "deep";
      broadDepth: number;
      pool: StudyCandidate[];
      roots: number[];
      pass: number;
      cursor: number;
      challenged: Set<number>;
    };
    depth: number;
    nextTaskId: number;
    queue: number[];
    inflight: Map<number, Assignment>;
    parts: {
      pending: Map<string, PendingRoot>;
      queue: { planKey: string; task: StudySubtreeTask }[];
      owners: Map<string, number>;
    } | null;
    results: Map<number, StudyCandidate>;
    all: Map<number, StudyCandidate>;
    material: Set<number>;
    owners: Map<number, number>;
    waiting: number[];
    waitMs: number[];
    depths: { depth: number; elapsedMs: number; roots: number }[];
    total: number;
    completedIterationWork: number;
  } | null;
  snapshot: StudySearchSnapshot;
  lanes: (Lane | null)[];
  proofs: Map<number, Pick<StudyCandidate, "study" | "danger">>;
  published: StudyCandidate[];
  selected: number[] | null;
  releasedDepth: number;
  callback: (value: StudySearchSnapshot) => void;
  started: number;
  consumed: number;
  timer: ReturnType<typeof setTimeout> | null;
  input: StudyPositionInput;
  position: AnalysisPosition;
  options: StudySearchOptions;
  prepared: boolean;
  preparation: number;
};
export interface StudySearchRuntime {
  start(
    input: StudyPositionInput,
    options: StudySearchOptions,
    onProgress?: (value: StudySearchSnapshot) => void,
  ): Promise<string>;
  get(id: string): StudySearchSnapshot | null;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  close(): Promise<void>;
}

export function createStudySearchRuntime(
  config: StudySearchRuntimeConfig = {},
): StudySearchRuntime {
  const threads = config.threads ?? 4;
  const memoryMb = config.memoryMb ?? 8192;
  const startupTimeoutMs = config.startupTimeoutMs ?? 10000;
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? 500;
  const reuseWorkers = config.reuseWorkers ?? config.workerScript === undefined;
  const parallelOrigin = performance.now();
  if (
    !Number.isSafeInteger(threads) ||
    threads < 1 ||
    threads > 32 ||
    !Number.isSafeInteger(memoryMb) ||
    memoryMb < 128 ||
    memoryMb > 65536
  )
    throw new TypeError("探索プロセスは1〜32、メモリは128〜65536MiBです");
  if (![startupTimeoutMs, shutdownTimeoutMs].every((value) => Number.isFinite(value) && value > 0))
    throw new TypeError("プロセスの起動・終了期限は正のミリ秒です");

  if (!["root", "replies"].includes(config.taskPartition ?? "root"))
    throw new TypeError("タスク分割はrootまたはrepliesです");
  let children: ChildProcess[] = [];
  let starting: Promise<void> | null = null;
  let terminating = Promise.resolve();
  let generation = 0;
  let closed = false;
  let job: Job | null = null;
  const history = new Map<string, StudySearchSnapshot>();

  function parentCost<T>(operation: "dispatch" | "merge", run: () => T): T {
    if (!config.observeParallel) return run();
    const id = job?.snapshot.id ?? null,
      started = performance.now(),
      cpu = process.cpuUsage();
    try {
      return run();
    } finally {
      const used = process.cpuUsage(cpu);
      config.observeParallel({
        type: "parent",
        id,
        operation,
        atMs: started - parallelOrigin,
        wallMs: performance.now() - started,
        cpuMs: (used.user + used.system) / 1000,
      });
    }
  }
  function sendTo(worker: number, message: SearchCommand, callback: (error: Error | null) => void) {
    if (!config.observeParallel) {
      children[worker].send(message, callback);
      return;
    }
    const probe = performance.now();
    const jsonBytes = Buffer.byteLength(JSON.stringify(message));
    const sent = performance.now();
    children[worker].send(message, callback);
    config.observeParallel({
      type: "ipc",
      id: "id" in message ? message.id : (job?.snapshot.id ?? null),
      worker,
      direction: "send",
      atMs: sent - parallelOrigin,
      jsonBytes,
      sizingMs: sent - probe,
      callMs: performance.now() - sent,
    });
  }

  function exited(child: ChildProcess) {
    return child.exitCode !== null || child.signalCode !== null;
  }
  function elapsed(value: Job) {
    return (
      value.consumed + (value.snapshot.status === "running" ? performance.now() - value.started : 0)
    );
  }
  function snapshot(value: Job): StudySearchSnapshot {
    if (value.snapshot.timing) {
      value.snapshot.timing.incompleteTasks = value.dynamic?.inflight.size ?? 0;
      value.snapshot.timing.queuedTasks = value.dynamic?.queue.length ?? 0;
      value.snapshot.timing.pendingRoots = value.dynamic?.parts?.pending.size ?? 0;
      value.snapshot.timing.queuedSubtrees = value.dynamic?.parts?.queue.length ?? 0;
      if (value.snapshot.performance && value.dynamic) {
        const dynamic = value.dynamic;
        value.snapshot.performance.workerWaitMs = dynamic.waitMs.map(
          (wait, worker) =>
            wait +
            (dynamic.inflight.has(worker)
              ? 0
              : Math.max(0, elapsed(value) - dynamic.waiting[worker])),
        );
      }
    }
    return structuredClone({ ...value.snapshot, elapsedMs: elapsed(value) });
  }
  function emit(value: Job) {
    const result = snapshot(value);
    history.set(result.id, structuredClone(result));
    while (history.size > 16) history.delete(history.keys().next().value!);
    value.callback(result);
  }
  function freezeTime(value: Job) {
    value.consumed = elapsed(value);
    if (value.timer) clearTimeout(value.timer);
    value.timer = null;
  }
  function terminateWorkers(graceful = false) {
    const previous = children;
    children = [];
    const ended = previous.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (exited(child)) return resolve();
          const timer = setTimeout(() => child.kill("SIGKILL"), shutdownTimeoutMs);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          if (graceful && child.connected) {
            child.send({ type: "close" } satisfies SearchCommand, (error) => {
              if (error && !exited(child)) child.kill("SIGKILL");
            });
          } else child.kill("SIGKILL");
        }),
    );
    terminating = Promise.all([terminating, ...ended]).then(() => {});
    return terminating;
  }
  function sendDiagnostic(event: StudyRuntimeTraceEvent) {
    config.observeDiagnostic?.(structuredClone(event));
  }
  function command(message: SearchCommand) {
    for (const [worker, child] of children.entries()) {
      if (!child.connected) continue;
      if (job?.snapshot.timing) job.snapshot.timing.ipcCommands++;
      if (config.observeDiagnostic) sendDiagnostic({ type: "command", worker, command: message });
      sendTo(worker, message, (error) => {
        if (
          error &&
          children.includes(child) &&
          job &&
          (job.snapshot.status === "running" || job.snapshot.status === "paused")
        )
          stop("error", "探索プロセスへ操作を送れませんでした", true);
      });
    }
  }
  function stop(status: StudySearchSnapshot["status"], reason: string, discard: boolean) {
    if (!job || !["running", "paused"].includes(job.snapshot.status)) return;
    freezeTime(job);
    job.snapshot.status = status;
    job.snapshot.reason = reason;
    job.preparation++;
    if (!job.prepared && job.snapshot.focus) {
      job.snapshot.focus.status = reason === "deadline" ? "unreached" : "cancelled";
      job.snapshot.focus.reason = reason === "deadline" ? "deadline" : "cancelled";
      job.snapshot.focus.projectionElapsedMs = elapsed(job);
    }
    const reusableCompletion =
      reuseWorkers &&
      status === "completed" &&
      ["max_depth", "sole_win", "terminal"].includes(reason);
    if (discard && !reusableCompletion) void terminateWorkers();
    else if (reusableCompletion) {
      // 続行しない終端では探索状態を解放し、プロセスだけを次の入力へ残します。
      command({ type: "cancel", id: job.snapshot.id });
    } else command({ type: "pause", id: job.snapshot.id });
    emit(job);
  }
  function merge(value: Job) {
    return parentCost("merge", () => mergeImpl(value));
  }
  function mergeImpl(value: Job) {
    const lanes = value.lanes.filter((entry): entry is Lane => entry !== null);
    value.snapshot.work = lanes.reduce((sum, entry) => sum + entry.snapshot.stats.work, 0);
    value.snapshot.nodes = lanes.reduce((sum, entry) => sum + entry.snapshot.stats.nodes, 0);
    value.snapshot.memoryBytes = lanes.reduce((sum, entry) => sum + entry.memoryBytes, 0);
    if (value.snapshot.timing) {
      value.snapshot.timing.workers = value.lanes.map((lane) => lane?.timing ?? null);
      value.snapshot.timing.incompleteTasks = value.dynamic?.inflight.size ?? 0;
      value.snapshot.timing.queuedTasks = value.dynamic?.queue.length ?? 0;
      value.snapshot.timing.pendingRoots = value.dynamic?.parts?.pending.size ?? 0;
      value.snapshot.timing.queuedSubtrees = value.dynamic?.parts?.queue.length ?? 0;
    }
    if (lanes.some((entry) => entry.snapshot.performance)) {
      const sum = (key: keyof StudySearchPerformance) =>
        lanes.reduce((n, entry) => n + (entry.snapshot.performance?.[key] ?? 0), 0);
      value.snapshot.performance = {
        legalMs: sum("legalMs"),
        transitionMs: sum("transitionMs"),
        evaluationMs: sum("evaluationMs"),
        orderingMs: sum("orderingMs"),
        initialLegalMs: sum("initialLegalMs"),
        initialEvaluationMs: sum("initialEvaluationMs"),
        priorityMs: sum("priorityMs"),
        priorityCalls: sum("priorityCalls"),
        orderingBonusMs: sum("orderingBonusMs"),
        legalCalls: sum("legalCalls"),
        checkCalls: sum("checkCalls"),
        checkMs: sum("checkMs"),
        checkCacheHits: sum("checkCacheHits"),
        generatedMoves: lanes.reduce((n, entry) => n + entry.snapshot.stats.generatedMoves, 0),
        cacheEvictions: sum("cacheEvictions"),
        branchCacheHits: sum("branchCacheHits"),
        branchCacheEntries: sum("branchCacheEntries"),
        keyMs: sum("keyMs"),
        immediateWork: sum("immediateWork"),
        materialWork: sum("materialWork"),
        preparationWork: sum("preparationWork"),
        rootSetupWork: sum("rootSetupWork"),
        completedIterationWork: value.dynamic?.completedIterationWork ?? 0,
        reducedNodes: sum("reducedNodes"),
        researches: sum("researches"),
        promotionExtraMoves: sum("promotionExtraMoves"),
        checkingExtraMoves: sum("checkingExtraMoves"),
        checkingReserveNodes: sum("checkingReserveNodes"),
        extendedNodes: sum("extendedNodes"),
        quiescenceStops: sum("quiescenceStops"),
        quiescenceMoves: sum("quiescenceMoves"),
        subtreeStateCacheHits: sum("subtreeStateCacheHits"),
        subtreeStateCacheEntries: sum("subtreeStateCacheEntries"),
        subtreeStateKeyMs: sum("subtreeStateKeyMs"),
        legalCacheHits: lanes.reduce((n, entry) => n + entry.snapshot.stats.legalCacheHits, 0),
        transitionCacheHits: lanes.reduce(
          (n, entry) => n + entry.snapshot.stats.transitionCacheHits,
          0,
        ),
        evaluationCacheHits: lanes.reduce(
          (n, entry) => n + entry.snapshot.stats.evaluationCacheHits,
          0,
        ),
        iterationDepth: value.dynamic?.depth ?? value.snapshot.completedDepth + 1,
        completedTasks: value.dynamic?.results.size ?? 0,
        totalTasks: value.dynamic?.total ?? 0,
        workerNodes: value.lanes.map((entry) => entry?.snapshot.stats.nodes ?? 0),
        workerWaitMs:
          value.dynamic?.waitMs.map(
            (wait, worker) =>
              wait +
              (value.dynamic!.inflight.has(worker)
                ? 0
                : Math.max(0, elapsed(value) - value.dynamic!.waiting[worker])),
          ) ?? [],
        depths: value.dynamic?.depths ?? [],
      };
    }
    const root = value.snapshot.rootSide;
    if (root) {
      const merged = value.published
        .map((candidate) => {
          const proof = value.proofs.get(candidate.rootIndex);
          return proof
            ? {
                ...candidate,
                study: {
                  ...candidate.study,
                  immediateLoss: proof.study.immediateLoss,
                  immediateRepliesComplete: proof.study.immediateRepliesComplete,
                  material: {
                    ...candidate.study.material,
                    lossWitness: proof.study.material.lossWitness,
                    complete: proof.study.material.complete,
                    limit: proof.study.material.limit,
                  },
                  explanations: [
                    ...new Set([
                      ...candidate.study.explanations,
                      ...(proof.study.immediateLoss
                        ? ["次の相手手番で自分が脱落する合法手があります。"]
                        : []),
                      ...(proof.study.material.lossWitness
                        ? ["次の実自手番までに資産が減る合法な応手列があります。"]
                        : []),
                    ]),
                  ],
                },
                danger: { ...candidate.danger, alternatives: proof.danger.alternatives },
              }
            : candidate;
        })
        .sort((a, b) => compareStudyCandidates(a, b, root));
      value.snapshot.candidates = merged.slice(0, 5);
      value.snapshot.analysisRecommendedAction =
        merged[0]?.action ?? value.snapshot.analysisRecommendedAction;
      value.snapshot.recommendedAction =
        value.snapshot.analysisStateHash === value.snapshot.stateHash
          ? value.snapshot.analysisRecommendedAction
          : null;
      value.snapshot.evaluation = merged[0]?.evaluation ?? null;
      value.snapshot.diagnostics.safetyComplete =
        merged.length > 0 && merged.every((entry) => entry.study.immediateRepliesComplete);
    }
  }
  function recordProof(value: Job, candidate: StudyCandidate) {
    const previous = value.proofs.get(candidate.rootIndex);
    const material = candidate.study.material;
    const oldMaterial = previous?.study.material;
    const complete = material.complete || oldMaterial?.complete === true;
    const alternatives = candidate.danger.alternatives;
    const oldAlternatives = previous?.danger.alternatives;
    const base = alternatives ?? oldAlternatives;
    value.proofs.set(candidate.rootIndex, {
      study: {
        ...candidate.study,
        immediateLoss: candidate.study.immediateLoss ?? previous?.study.immediateLoss ?? null,
        immediateRepliesComplete:
          candidate.study.immediateRepliesComplete ||
          previous?.study.immediateRepliesComplete === true,
        material: {
          ...material,
          complete,
          limit: complete ? null : material.limit,
          lossWitness: material.lossWitness ?? oldMaterial?.lossWitness ?? null,
        },
      },
      danger: {
        ...candidate.danger,
        alternatives: base
          ? {
              ...base,
              complete: alternatives?.complete === true || oldAlternatives?.complete === true,
              limit: alternatives?.complete || oldAlternatives?.complete ? null : base.limit,
              eliminationWitness:
                alternatives?.eliminationWitness ?? oldAlternatives?.eliminationWitness ?? null,
              rookLossWitness:
                alternatives?.rookLossWitness ?? oldAlternatives?.rookLossWitness ?? null,
            }
          : null,
      },
    });
  }
  function startChildren(value: Job, input: StudyPositionInput) {
    if (job !== value || value.snapshot.status !== "running") return;
    const {
      timeBudgetMs: _time,
      focusSide: _focus,
      broadDepth: _broad,
      ...rootOptions
    } = value.options;
    value.prepared = true;
    children.forEach((_child, lane) => {
      const message: SearchCommand = {
        type: "start",
        id: value.snapshot.id,
        input,
        ...(config.observeParallel ? { measureTransport: true } : {}),
        options: {
          ...rootOptions,
          measureDetails: config.measureStages === true,
          strategy: value.dynamic ? (value.options.strategy ?? "adaptive") : "legacy",
          cacheSize:
            rootOptions.cacheSize ??
            (value.dynamic
              ? Math.min(8192, Math.max(256, Math.floor((memoryMb / threads) * 4)))
              : 1024),
          lane,
          lanes: threads,
        },
      };
      if (config.observeDiagnostic)
        sendDiagnostic({ type: "command", worker: lane, command: message });
      if (value.snapshot.timing) value.snapshot.timing.ipcCommands++;
      sendTo(lane, message, (error) => {
        if (error && job === value) stop("error", "探索を開始できませんでした", true);
      });
    });
  }
  function dispatchTasks(value: Job) {
    return parentCost("dispatch", () => dispatchTasksImpl(value));
  }
  function dispatchTasksImpl(value: Job) {
    const dynamic = value.dynamic;
    if (!dynamic || value.snapshot.status !== "running") return;
    const workers = children.map((_, worker) => worker);
    if (dynamic.parts) {
      const parts = dynamic.parts;
      const priority = Array(threads).fill(0) as number[];
      for (const entry of parts.queue) {
        const owner = parts.owners.get(`${entry.task.rootIndex}:${entry.task.slot}`);
        if (owner !== undefined) priority[owner] = 1;
      }
      for (const pending of parts.pending.values())
        if (!pending.finishing && pending.results.size === pending.plan.tasks.length)
          priority[pending.owner] = 2;
      workers.sort((a, b) => priority[b] - priority[a] || a - b);
    }
    workers.forEach((worker) => {
      if (dynamic.inflight.has(worker)) return;
      const parts = dynamic.parts;
      const finish =
        parts &&
        [...parts.pending.entries()].find(
          ([, pending]) =>
            pending.owner === worker &&
            !pending.finishing &&
            pending.results.size === pending.plan.tasks.length,
        );
      const preferredPart =
        parts?.queue.findIndex(
          (entry) => parts.owners.get(`${entry.task.rootIndex}:${entry.task.slot}`) === worker,
        ) ?? -1;
      const part =
        !finish && parts?.queue.length
          ? parts.queue.splice(preferredPart < 0 ? 0 : preferredPart, 1)[0]
          : undefined;
      if (finish || part) {
        const taskId = ++dynamic.nextTaskId;
        const pending = finish ? finish[1] : parts!.pending.get(part!.planKey)!;
        const planKey = finish ? finish[0] : part!.planKey;
        const kind = finish ? ("finish" as const) : ("subtree" as const);
        dynamic.waitMs[worker] += Math.max(0, elapsed(value) - dynamic.waiting[worker]);
        dynamic.inflight.set(worker, {
          index: pending.index,
          taskId,
          kind,
          planKey,
          slot: part?.task.slot,
        });
        if (finish) pending.finishing = true;
        else {
          const affinityKey = `${part!.task.rootIndex}:${part!.task.slot}`;
          if (parts!.owners.size >= 256 && !parts!.owners.has(affinityKey))
            parts!.owners.delete(parts!.owners.keys().next().value!);
          parts!.owners.set(affinityKey, worker);
          if (value.snapshot.timing)
            value.snapshot.timing.subtreeTasksAssigned =
              (value.snapshot.timing.subtreeTasksAssigned ?? 0) + 1;
        }
        config.observeParallel?.({
          type: "assigned",
          id: value.snapshot.id,
          atMs: performance.now() - parallelOrigin,
          worker,
          taskId,
          role: kind,
          index: pending.index,
          depth: dynamic.depth,
          phase: dynamic.dual?.phase ?? "adaptive",
        });
        const message: SearchCommand = finish
          ? {
              type: "finish",
              id: value.snapshot.id,
              taskId,
              planId: pending.plan.planId,
              results: pending.plan.tasks.map((task) => pending.results.get(task.slot)!),
            }
          : {
              type: "subtree",
              id: value.snapshot.id,
              taskId,
              task:
                pending.owner === worker
                  ? { localPlanId: pending.plan.planId, slot: part!.task.slot }
                  : part!.task,
            };
        if (config.observeDiagnostic) sendDiagnostic({ type: "command", worker, command: message });
        if (value.snapshot.timing) value.snapshot.timing.ipcCommands++;
        sendTo(worker, message, (error) => {
          if (error && job === value) stop("error", "独立探索タスクを送れませんでした", true);
        });
        return;
      }
      if (!dynamic.queue.length) return;
      const preferred = dynamic.queue.findIndex((index) => dynamic.owners.get(index) === worker);
      const [index] = dynamic.queue.splice(preferred < 0 ? 0 : preferred, 1);
      dynamic.waitMs[worker] += Math.max(0, elapsed(value) - dynamic.waiting[worker]);
      const taskId = ++dynamic.nextTaskId;
      dynamic.inflight.set(worker, { index, taskId });
      if (value.snapshot.timing) {
        value.snapshot.timing.tasksAssigned++;
        if (dynamic.dual?.phase === "deep") value.snapshot.timing.deepTasksAssigned++;
      }
      dynamic.owners.set(index, worker);
      config.observeParallel?.({
        type: "assigned",
        id: value.snapshot.id,
        atMs: performance.now() - parallelOrigin,
        worker,
        taskId,
        index,
        depth: dynamic.depth,
        phase: dynamic.dual?.phase ?? "adaptive",
      });
      const message: SearchCommand = {
        type: "task",
        id: value.snapshot.id,
        taskId,
        index,
        depth: dynamic.depth,
        material: dynamic.depth === 2 && dynamic.material.has(index),
        ...(dynamic.parts && dynamic.dual?.phase === "deep" && threads > 1
          ? { partition: true }
          : {}),
        ...(dynamic.dual
          ? {
              policy: {
                phase: dynamic.dual.phase,
                width:
                  dynamic.dual.phase === "deep"
                    ? Math.min(8, 2 + dynamic.dual.pass)
                    : (value.options.width ?? 6),
                ownWidth: Math.min(10, 3 + dynamic.dual.pass),
              },
            }
          : {}),
      };
      if (config.observeDiagnostic) sendDiagnostic({ type: "command", worker, command: message });
      if (value.snapshot.timing) value.snapshot.timing.ipcCommands++;
      sendTo(worker, message, (error) => {
        if (error && job === value) stop("error", "探索タスクを送れませんでした", true);
      });
    });
  }
  function beginIteration(value: Job) {
    const dynamic = value.dynamic!;
    const dual = dynamic.dual;
    if (
      value.snapshot.timing &&
      dual?.phase === "deep" &&
      value.snapshot.timing.deepStartedMs === null
    )
      value.snapshot.timing.deepStartedMs = elapsed(value);
    dynamic.queue =
      dual?.phase === "deep"
        ? [...dual.roots]
        : dual
          ? selectStudyRootIndices(
              [...dynamic.all.values()],
              value.snapshot.rootSide!,
              value.options.rootWidth ?? 24,
            )
          : selectStudyIterationRoots(
              [...dynamic.all.values()],
              value.snapshot.rootSide!,
              dynamic.depth,
              value.options.rootWidth ?? 24,
            );
    if (config.observeDiagnostic)
      sendDiagnostic({
        type: "iteration",
        depth: dynamic.depth,
        phase: dual?.phase ?? "adaptive",
        roots: [...dynamic.queue],
      });
    dynamic.total = dynamic.queue.length;
    config.observeParallel?.({
      type: "iteration",
      id: value.snapshot.id,
      atMs: performance.now() - parallelOrigin,
      depth: dynamic.depth,
      phase: dual?.phase ?? "adaptive",
      roots: dynamic.total,
    });
    dynamic.results.clear();
    value.snapshot.diagnostics.selectedRoots = dynamic.total;
    if (value.snapshot.performance) {
      value.snapshot.performance.iterationDepth = dynamic.depth;
      value.snapshot.performance.completedTasks = 0;
      value.snapshot.performance.totalTasks = dynamic.total;
    }
    dispatchTasks(value);
  }
  function rotateDeep(value: Job) {
    const dynamic = value.dynamic!;
    const dual = dynamic.dual!;
    const best = [...value.published].sort((a, b) =>
      compareStudyCandidates(a, b, value.snapshot.rootSide!),
    )[0];
    const reserve = dual.pool.filter((entry) => entry.rootIndex !== best?.rootIndex);
    dual.roots = best ? [best.rootIndex] : [];
    for (let offset = 0; offset < Math.min(2, reserve.length); offset++)
      dual.roots.push(reserve[(dual.cursor + offset) % reserve.length].rootIndex);
    dual.cursor += 2;
    if (!dual.roots.length) dual.roots = dual.pool.slice(0, 3).map((entry) => entry.rootIndex);
  }
  function finishIteration(value: Job) {
    const dynamic = value.dynamic!;
    if (
      value.snapshot.status !== "running" ||
      dynamic.inflight.size ||
      dynamic.queue.length ||
      dynamic.parts?.pending.size ||
      dynamic.parts?.queue.length ||
      dynamic.results.size !== dynamic.total
    )
      return;
    const dual = dynamic.dual;
    config.observeParallel?.({
      type: "iterationEnd",
      id: value.snapshot.id,
      atMs: performance.now() - parallelOrigin,
      depth: dynamic.depth,
      phase: dual?.phase ?? "adaptive",
      roots: dynamic.total,
    });
    const completed = [...dynamic.results.values()];
    dynamic.completedIterationWork += completed.reduce((n, c) => n + c.iterationWork, 0);
    const publish = !dual || dynamic.depth >= value.snapshot.completedDepth;
    if (publish) {
      value.published = completed;
      value.snapshot.completedDepth = dynamic.depth;
      if (value.snapshot.timing && dynamic.depth === 2 && value.snapshot.timing.depthTwoMs === null)
        value.snapshot.timing.depthTwoMs = elapsed(value);
    }
    if (dual?.phase === "broad") {
      value.snapshot.broadCandidates = [...completed]
        .sort((a, b) => compareStudyCandidates(a, b, value.snapshot.rootSide!))
        .slice(0, 5);
      dual.pool = [...completed].sort((a, b) =>
        compareStudyCandidates(a, b, value.snapshot.rootSide!),
      );
      value.snapshot.coverage = {
        phase: "broad",
        broadDepth: dynamic.depth,
        broadRoots: completed.length,
        deepRoots: 0,
        pass: 0,
        opponentWidth: value.options.width ?? 6,
        ownWidth: value.options.width ?? 6,
      };
    } else if (dual && publish) {
      value.snapshot.coverage = {
        ...value.snapshot.coverage!,
        phase: "deep",
        deepRoots: completed.length,
        pass: dual.pass,
        opponentWidth: Math.min(8, 2 + dual.pass),
        ownWidth: Math.min(10, 3 + dual.pass),
      };
    }
    if (config.observeDiagnostic)
      sendDiagnostic({
        type: "publication",
        depth: dynamic.depth,
        published: publish,
        candidates: completed,
        coverage: value.snapshot.coverage,
      });
    dynamic.depths.push({ depth: dynamic.depth, elapsedMs: elapsed(value), roots: dynamic.total });
    merge(value);
    const best = value.snapshot.candidates[0];
    if (
      (best?.evaluation?.evaluationKind === "terminal" &&
        best.evaluation.values[value.snapshot.rootSide!].primary === 1) ||
      dynamic.depth >= (value.options.maxDepth ?? 256)
    ) {
      stop(
        "completed",
        dynamic.depth >= (value.options.maxDepth ?? 256) ? "max_depth" : "sole_win",
        true,
      );
      return;
    }
    if (dual) {
      if (dual.phase === "broad" && dynamic.depth >= dual.broadDepth) {
        dual.phase = "deep";
        dual.roots = dual.pool.slice(0, 3).map((entry) => entry.rootIndex);
      } else if (
        dual.phase === "deep" &&
        dynamic.depth >= Math.min(value.options.maxDepth ?? 256, 9 + Math.floor(dual.pass / 3))
      ) {
        dual.pass++;
        rotateDeep(value);
        dynamic.depth = dual.broadDepth;
      } else if (
        dual.phase === "deep" &&
        !dual.challenged.has(dynamic.depth) &&
        dual.pool.length > 3
      ) {
        const winner = [...completed].sort((a, b) =>
          compareStudyCandidates(a, b, value.snapshot.rootSide!),
        )[0];
        const original = dual.pool.find((entry) => entry.rootIndex === winner?.rootIndex);
        if (
          winner?.evaluation &&
          original?.evaluation &&
          (winner.evaluation.values[value.snapshot.rootSide!].heuristicScore ?? 0) <
            (original.evaluation.values[value.snapshot.rootSide!].heuristicScore ?? 0) - 200
        ) {
          dual.challenged.add(dynamic.depth);
          rotateDeep(value);
          beginIteration(value);
          return;
        }
      }
    }
    dynamic.depth++;
    beginIteration(value);
  }
  async function prepareFocus(value: Job) {
    const focus = value.snapshot.focus;
    if (!focus || job !== value || value.snapshot.status !== "running") return;
    const revision = ++value.preparation;
    focus.status = "preparing";
    focus.reason = null;
    const cancelled = () =>
      job !== value || value.preparation !== revision || value.snapshot.status !== "running";
    const remaining =
      value.options.timeBudgetMs === null
        ? 250
        : Math.max(1, value.options.timeBudgetMs - elapsed(value));
    try {
      const projected = await projectFocusPosition(
        value.position,
        focus.side,
        { timeBudgetMs: Math.min(250, remaining) },
        { isCancelled: cancelled },
      );
      if (cancelled()) return;
      if (
        projected.sourceStateHash !== value.snapshot.stateHash ||
        (projected.status === "ready" &&
          (!projected.position ||
            projected.position.state.turn !== focus.side ||
            projected.analysisStateHash !== projected.position.stateHash))
      )
        throw new Error("フォーカス予測の元局面・対象手番が一致しません");
      value.snapshot.focus = {
        side: focus.side,
        status: projected.status,
        reason: projected.reason,
        sourceStateHash: projected.sourceStateHash,
        analysisStateHash: projected.analysisStateHash,
        prefix: projected.prefix,
        conditional: projected.prefix.length > 0,
        projectionElapsedMs: projected.elapsedMs,
        model: projected.model,
        result: projected.result,
      };
      value.snapshot.analysisStateHash = projected.analysisStateHash;
      if (projected.status !== "ready" || !projected.position) {
        if (
          projected.reason === "deadline" &&
          value.options.timeBudgetMs !== null &&
          elapsed(value) >= value.options.timeBudgetMs
        ) {
          stop("completed", "deadline", false);
          return;
        }
        // 未到達の条件付き局面へ、現在の手番を差し替えて探索を続けません。
        value.prepared = true;
        stop(
          "completed",
          projected.status === "focus_eliminated"
            ? "focus_eliminated"
            : `focus_${projected.status}`,
          true,
        );
        return;
      }
      const fallback = getAnalysisLegalActions(projected.position)[0] ?? null;
      value.snapshot.analysisRecommendedAction = fallback;
      value.snapshot.recommendedAction =
        projected.analysisStateHash === value.snapshot.stateHash ? fallback : null;
      if (value.options.timeBudgetMs !== null && elapsed(value) >= value.options.timeBudgetMs) {
        value.snapshot.analysisStateHash = null;
        value.snapshot.analysisRecommendedAction = null;
        value.snapshot.recommendedAction = null;
        value.snapshot.focus.analysisStateHash = null;
        stop("completed", "deadline", false);
        return;
      }
      startChildren(value, {
        ...value.input,
        events: [
          ...value.input.events,
          ...projected.prefix.map((step) => ({
            type: "action" as const,
            side: step.side,
            action: step.action,
          })),
        ],
      });
      emit(value);
    } catch (error) {
      if (cancelled()) return;
      value.prepared = true;
      value.snapshot.focus!.status = "error";
      value.snapshot.focus!.reason = String(error);
      stop("error", `フォーカス局面の予測に失敗しました: ${String(error)}`, true);
    }
  }
  function advanceBarrier(value: Job) {
    if (value.snapshot.status !== "running") return;
    const lanes = value.lanes;
    if (!lanes.every((entry) => entry?.barrier)) return;
    const completed = lanes as Lane[];
    const depth = completed[0].snapshot.depth;
    const allDone = completed.every((entry) => entry.snapshot.done);
    if (
      (depth <= value.releasedDepth && !allDone) ||
      !completed.every((entry) => entry.snapshot.depth === depth)
    )
      return;
    if (depth > value.snapshot.completedDepth) {
      value.published = completed.flatMap((entry) => entry.snapshot.candidates);
      value.snapshot.completedDepth = depth;
      if (value.snapshot.timing && depth === 1) value.snapshot.timing.depthOneMs = elapsed(value);
      if (depth === 1 && value.snapshot.rootSide) {
        value.snapshot.diagnostics.legalRoots = value.published.length;
        value.selected = selectStudyRootIndices(
          value.published,
          value.snapshot.rootSide,
          value.snapshot.diagnostics.selectedRoots,
        );
        value.snapshot.diagnostics.selectedRoots = value.selected.length;
      }
      merge(value);
      if (value.dynamic?.dual && depth === 1) {
        value.snapshot.coverage = {
          phase: "broad",
          broadDepth: 1,
          broadRoots: value.published.length,
          deepRoots: 0,
          pass: 0,
          opponentWidth: value.options.width ?? 6,
          ownWidth: value.options.width ?? 6,
        };
        value.snapshot.broadCandidates = value.snapshot.candidates;
      }
    }
    const soleWin =
      value.snapshot.candidates[0]?.evaluation?.evaluationKind === "terminal" &&
      value.snapshot.rootSide !== null &&
      value.snapshot.candidates[0].evaluation.values[value.snapshot.rootSide].primary === 1;
    if (allDone || soleWin || depth >= (value.options.maxDepth ?? 256)) {
      stop("completed", soleWin ? "sole_win" : depth === 0 ? "terminal" : "max_depth", true);
      return;
    }
    if (value.dynamic) {
      value.releasedDepth = depth;
      const dynamic = value.dynamic;
      value.published.forEach((entry) => dynamic.all.set(entry.rootIndex, entry));
      dynamic.material = new Set(value.selected!.slice(0, 5));
      if (config.observeDiagnostic)
        sendDiagnostic({
          type: "publication",
          depth: 1,
          published: true,
          candidates: value.published,
          coverage: value.snapshot.coverage,
        });
      dynamic.depths.push({ depth: 1, elapsedMs: elapsed(value), roots: value.published.length });
      dynamic.waiting.fill(elapsed(value));
      beginIteration(value);
      return;
    }
    // 同じ深さを全レーンで比較してから、次の反復を一つだけ開始します。
    value.releasedDepth = depth;
    for (const entry of completed) entry.barrier = false;
    command({
      type: "continue",
      id: value.snapshot.id,
      depth,
      ...(depth === 1 ? { indices: value.selected! } : {}),
    });
  }
  function receive(index: number, message: SearchMessage) {
    if (
      message.type === "ready" ||
      !job ||
      message.id !== job.snapshot.id ||
      !["running", "paused"].includes(job.snapshot.status)
    )
      return;
    if (message.type === "error") {
      stop("error", message.error, true);
      return;
    }
    const value = job;
    if (value.snapshot.timing) value.snapshot.timing.ipcMessages++;
    if (value.snapshot.timing && value.snapshot.timing.firstWorkerMs === null)
      value.snapshot.timing.firstWorkerMs = elapsed(value);
    if (message.taskId !== undefined && value.dynamic) {
      const dynamic = value.dynamic;
      const assignment = dynamic.inflight.get(index);
      if (!assignment || assignment.taskId !== message.taskId) return;
      value.lanes[index] = {
        snapshot: message.snapshot,
        memoryBytes: message.memoryBytes,
        barrier: message.barrier,
        timing: message.timing,
      };
      if (message.barrier && message.reply?.kind === "split") {
        const parts = dynamic.parts;
        const plan = message.reply.plan;
        const key = `${index}:${plan.planId}`;
        if (
          !parts ||
          assignment.kind ||
          parts.pending.has(key) ||
          parts.pending.size >= 3 ||
          !Number.isSafeInteger(plan.planId) ||
          plan.planId < 1 ||
          plan.tasks.length < 2 ||
          plan.tasks.length > 16 ||
          new Set(plan.tasks.map((task) => task.slot)).size !== plan.tasks.length ||
          plan.tasks.some(
            (task) =>
              task.baseStateHash !== value.snapshot.analysisStateHash ||
              task.rootIndex !== assignment.index ||
              task.targetDepth !== dynamic.depth ||
              task.ply !== 2 ||
              task.remaining !== dynamic.depth - 2 ||
              task.policy.phase !== "deep",
          ) ||
          parts.queue.length + plan.tasks.length > 48
        ) {
          stop("error", "独立探索の分割計画が不正です", true);
          return;
        }
        parts.pending.set(key, {
          owner: index,
          index: assignment.index,
          plan,
          results: new Map(),
          finishing: false,
        });
        parts.queue.push(...plan.tasks.map((task) => ({ planKey: key, task })));
        if (value.snapshot.timing)
          value.snapshot.timing.splitPlans = (value.snapshot.timing.splitPlans ?? 0) + 1;
        dynamic.inflight.delete(index);
        dynamic.waiting[index] = elapsed(value);
      } else if (message.barrier && assignment.kind === "subtree") {
        const pending = dynamic.parts?.pending.get(assignment.planKey!);
        const result = message.reply?.kind === "subtree" ? message.reply.result : null;
        if (
          !pending ||
          !result ||
          result.slot !== assignment.slot ||
          pending.results.has(result.slot)
        ) {
          stop("error", "独立探索の結果が不足または重複しています", true);
          return;
        }
        pending.results.set(result.slot, result);
        if (value.snapshot.timing)
          value.snapshot.timing.subtreeTasksCompleted =
            (value.snapshot.timing.subtreeTasksCompleted ?? 0) + 1;
        dynamic.inflight.delete(index);
        dynamic.waiting[index] = elapsed(value);
      } else if (message.barrier) {
        if (message.reply) {
          stop("error", "探索タスクの応答種別が一致しません", true);
          return;
        }
        if (assignment.kind === "finish") {
          const pending = dynamic.parts?.pending.get(assignment.planKey!);
          if (
            !pending ||
            pending.owner !== index ||
            pending.results.size !== pending.plan.tasks.length
          ) {
            stop("error", "分割探索の集約条件が一致しません", true);
            return;
          }
          dynamic.parts!.pending.delete(assignment.planKey!);
        }
        const candidate = message.snapshot.candidates[0];
        if (
          message.snapshot.depth !== dynamic.depth ||
          message.snapshot.candidates.length !== 1 ||
          candidate?.rootIndex !== assignment.index
        ) {
          stop("error", "探索タスクの根または深さが一致しません", true);
          return;
        }
        dynamic.results.set(candidate.rootIndex, candidate);
        if (value.snapshot.timing) value.snapshot.timing.tasksCompleted++;
        dynamic.all.set(candidate.rootIndex, candidate);
        recordProof(value, candidate);
        dynamic.inflight.delete(index);
        dynamic.waiting[index] = elapsed(value);
      }
      merge(value);
      if (value.snapshot.memoryBytes > memoryMb * 1024 * 1024) {
        stop("completed", "memory_limit", true);
        return;
      }
      dispatchTasks(value);
      finishIteration(value);
      if (["running", "paused"].includes(value.snapshot.status)) emit(value);
      return;
    }
    const previous = value.lanes[index];
    if (previous && message.snapshot.depth < previous.snapshot.depth) return;
    if (message.barrier && !message.snapshot.done && message.snapshot.depth <= value.releasedDepth)
      return;
    value.lanes[index] = {
      snapshot: message.snapshot,
      memoryBytes: message.memoryBytes,
      barrier: message.barrier,
      timing: message.timing,
    };
    for (const candidate of message.snapshot.candidates) recordProof(value, candidate);
    merge(value);
    if (value.snapshot.memoryBytes > memoryMb * 1024 * 1024) {
      stop("completed", "memory_limit", true);
      return;
    }
    advanceBarrier(value);
    if (["running", "paused"].includes(value.snapshot.status)) emit(value);
  }
  async function ensureWorkers() {
    await terminating;
    if (closed) throw new Error("探索サービスは終了しています");
    if (children.length === threads && children.every((child) => !exited(child) && child.connected))
      return;
    if (starting) return starting;
    starting = (async () => {
      await terminateWorkers();
      if (closed) throw new Error("探索サービスは終了しています");
      const pool: ChildProcess[] = [];
      children = pool;
      try {
        await Promise.all(
          Array.from(
            { length: threads },
            (_, index) =>
              new Promise<void>((resolve, reject) => {
                const workerPath = fileURLToPath(
                  config.workerScript ?? new URL("./worker.ts", import.meta.url),
                );
                const child = spawn(
                  process.execPath,
                  [
                    "--no-env-file",
                    ...(config.cpuProfileDirectory
                      ? ["--cpu-prof-md", `--cpu-prof-dir=${config.cpuProfileDirectory}`]
                      : []),
                    workerPath,
                  ],
                  {
                    stdio: ["ignore", "ignore", "pipe", "ipc"],
                  },
                );
                pool[index] = child;
                let errors = "";
                child.stderr?.on("data", (chunk) => {
                  errors = (errors + String(chunk)).slice(-2048);
                });
                const timer = setTimeout(() => {
                  reject(new Error("探索プロセスの起動がタイムアウトしました"));
                }, startupTimeoutMs);
                child.on("message", (raw: unknown) => {
                  if (closed || children !== pool) return;
                  const message = raw as SearchMessage;
                  const probe = config.observeParallel ? performance.now() : 0;
                  const jsonBytes = config.observeParallel
                    ? Buffer.byteLength(JSON.stringify(message))
                    : 0;
                  const handling = config.observeParallel ? performance.now() : 0;
                  if (config.observeParallel && message.type === "progress") {
                    const assignment = job?.dynamic?.inflight.get(index);
                    const accepted =
                      !!job &&
                      message.id === job.snapshot.id &&
                      ["running", "paused"].includes(job.snapshot.status) &&
                      (message.taskId === undefined || assignment?.taskId === message.taskId);
                    config.observeParallel({
                      type: "worker",
                      id: message.id,
                      atMs: handling - parallelOrigin,
                      worker: index,
                      taskId: message.taskId,
                      outcome: message.reply?.kind,
                      index: assignment?.index,
                      depth: message.snapshot.depth,
                      phase:
                        message.taskId === undefined
                          ? "prepare"
                          : (job?.dynamic?.dual?.phase ?? "adaptive"),
                      barrier: message.barrier,
                      accepted,
                      work: message.snapshot.stats.work,
                      nodes: message.snapshot.stats.nodes,
                      rss: message.memoryBytes,
                      activeMs: message.timing?.activeMs ?? 0,
                      cpuMs: message.timing?.cpuMs ?? 0,
                      restoreMs: message.timing?.restoreMs ?? 0,
                      createMs: message.timing?.createMs ?? 0,
                      taskInitMs: message.timing?.taskInitMs,
                      taskInitCpuMs: message.timing?.taskInitCpuMs,
                      processCpuMs: message.timing?.processCpuMs,
                      restoreCpuMs: message.timing?.restoreCpuMs,
                      createCpuMs: message.timing?.createCpuMs,
                      transport: message.timing?.transport
                        ? { ...message.timing.transport }
                        : undefined,
                    });
                  }
                  try {
                    if (config.observeDiagnostic)
                      sendDiagnostic({ type: "message", worker: index, message });
                    if (message.type === "ready") {
                      clearTimeout(timer);
                      resolve();
                    } else receive(index, message);
                  } finally {
                    config.observeParallel?.({
                      type: "ipc",
                      id: "id" in message ? message.id : null,
                      worker: index,
                      direction: "receive",
                      atMs: handling - parallelOrigin,
                      jsonBytes,
                      sizingMs: handling - probe,
                      callMs: performance.now() - handling,
                    });
                  }
                });
                child.once("error", (error) => {
                  clearTimeout(timer);
                  reject(error);
                });
                child.once("exit", () => {
                  clearTimeout(timer);
                  reject(new Error(`探索プロセスを起動できません ${errors}`));
                  if (
                    !closed &&
                    children === pool &&
                    job &&
                    ["running", "paused"].includes(job.snapshot.status)
                  )
                    stop("error", `探索プロセスが終了しました ${errors}`, true);
                });
              }),
          ),
        );
        if (closed || children !== pool) throw new Error("探索プロセスの起動が取り消されました");
      } catch (error) {
        if (children === pool) await terminateWorkers();
        throw error;
      }
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  }
  return {
    async start(input, options, onProgress = () => {}) {
      const requested = performance.now();
      if (closed) throw new Error("探索サービスは終了しています");
      if (
        options.timeBudgetMs !== null &&
        (!Number.isFinite(options.timeBudgetMs) ||
          options.timeBudgetMs < 1 ||
          options.timeBudgetMs > 3600000)
      )
        throw new TypeError("思考時間は1〜3600000msか無制限です");
      const token = ++generation;
      if (job && ["running", "paused"].includes(job.snapshot.status))
        stop("cancelled", "replaced", true);
      else if (!reuseWorkers) await terminateWorkers();
      const restoring = performance.now();
      const position = await restoreStudyPosition(input);
      const restored = performance.now();
      if (closed || token !== generation) throw new Error("探索の開始が取り消されました");
      await ensureWorkers();
      const ready = performance.now();
      if (closed || token !== generation) throw new Error("探索の開始が取り消されました");
      const staticEvaluation = evaluateStudyPosition(position);
      const evaluated = performance.now();
      const fallback = getAnalysisLegalActions(position)[0] ?? null;
      const legalReady = performance.now();
      const focusSide = options.focusSide ?? null;
      const id = crypto.randomUUID();
      if (
        options.broadDepth !== undefined &&
        (!Number.isSafeInteger(options.broadDepth) ||
          options.broadDepth < 2 ||
          options.broadDepth > 4)
      )
        throw new TypeError("広い比較の深さは2〜4です");
      job = {
        dynamic:
          options.strategy === "legacy" ||
          config.scheduling === "fixed" ||
          (config.workerScript && config.scheduling !== "dynamic")
            ? null
            : {
                depth: 2,
                nextTaskId: 0,
                queue: [],
                inflight: new Map(),
                parts:
                  config.taskPartition === "replies" &&
                  (options.strategy === "dual" || options.strategy === "dual-continuations")
                    ? { pending: new Map(), queue: [], owners: new Map() }
                    : null,
                results: new Map(),
                all: new Map(),
                material: new Set(),
                owners: new Map(),
                waiting: Array(threads).fill(0),
                waitMs: Array(threads).fill(0),
                depths: [],
                total: 0,
                completedIterationWork: 0,
                ...(isDualStudyStrategy(options.strategy)
                  ? {
                      dual: {
                        phase: "broad" as const,
                        broadDepth:
                          options.broadDepth ??
                          (options.timeBudgetMs !== null && options.timeBudgetMs < 2000 ? 2 : 3),
                        pool: [],
                        roots: [],
                        pass: 0,
                        cursor: 0,
                        challenged: new Set<number>(),
                      },
                    }
                  : {}),
              },
        snapshot: {
          ...(config.measureStages
            ? {
                timing: {
                  restoreMs: restored - restoring,
                  startupMs: ready - restored,
                  parentEvaluationMs: evaluated - ready,
                  parentLegalMs: legalReady - evaluated,
                  preSearchMs: legalReady - requested,
                  firstWorkerMs: null,
                  depthOneMs: null,
                  depthTwoMs: null,
                  deepStartedMs: null,
                  tasksAssigned: 0,
                  tasksCompleted: 0,
                  deepTasksAssigned: 0,
                  incompleteTasks: 0,
                  queuedTasks: 0,
                  workers: [],
                  ipcCommands: 0,
                  ipcMessages: 0,
                },
              }
            : {}),
          id,
          stateHash: position.stateHash,
          analysisStateHash: focusSide ? null : position.stateHash,
          focus: focusSide
            ? {
                side: focusSide,
                status: "preparing",
                reason: null,
                sourceStateHash: position.stateHash,
                analysisStateHash: null,
                prefix: [],
                conditional: false,
                projectionElapsedMs: 0,
                model: null,
                result: null,
              }
            : null,
          rootSide: focusSide ?? position.state.turn,
          status: "running",
          reason: null,
          elapsedMs: 0,
          completedDepth: 0,
          work: 0,
          nodes: 0,
          memoryBytes: 0,
          candidates: [],
          recommendedAction: focusSide ? null : fallback,
          analysisRecommendedAction: focusSide ? null : fallback,
          evaluation: !focusSide && position.state.status === "finished" ? staticEvaluation : null,
          staticEvaluation,
          workers: threads,
          diagnostics: {
            searchVersion:
              options.strategy === "legacy" ||
              config.scheduling === "fixed" ||
              (config.workerScript && config.scheduling !== "dynamic")
                ? legacyStudySearchVersion
                : studyStrategyVersion(options.strategy) +
                  (config.taskPartition === "replies" &&
                  (options.strategy === "dual" || options.strategy === "dual-continuations")
                    ? "-p1-3-replies"
                    : ""),
            profile: options.profile ?? "study",
            legalRoots: 0,
            selectedRoots: options.rootWidth ?? 24,
            safetyComplete: false,
          },
        },
        lanes: Array(threads).fill(null),
        proofs: new Map(),
        published: [],
        selected: null,
        releasedDepth: -1,
        callback: onProgress,
        started: performance.now(),
        consumed: 0,
        timer: null,
        input,
        position,
        options: { ...options },
        prepared: false,
        preparation: 0,
      };
      const { timeBudgetMs } = options;
      if (timeBudgetMs !== null) {
        const value = job;
        value.timer = setTimeout(() => {
          if (job === value) stop("completed", "deadline", false);
        }, timeBudgetMs);
      }
      emit(job);
      if (focusSide) void prepareFocus(job);
      else startChildren(job, input);
      return id;
    },
    get(id) {
      return job?.snapshot.id === id ? snapshot(job) : structuredClone(history.get(id) ?? null);
    },
    async pause(id) {
      if (job?.snapshot.id === id && job.snapshot.status === "running")
        stop("paused", "user", false);
    },
    async resume(id) {
      if (
        !job ||
        job.snapshot.id !== id ||
        !["paused", "completed"].includes(job.snapshot.status) ||
        ["memory_limit", "terminal", "max_depth", "sole_win"].includes(job.snapshot.reason ?? "") ||
        job.snapshot.reason?.startsWith("focus_")
      )
        return;
      job.snapshot.status = "running";
      job.snapshot.reason = null;
      job.started = performance.now();
      // 継続は既存の読みを保つ無制限解析です。時間を指定し直す場合は新しく開始します。
      job.options = { ...job.options, timeBudgetMs: null };
      if (!job.prepared && job.snapshot.focus) void prepareFocus(job);
      else command({ type: "resume", id });
      if (job.dynamic && job.dynamic.all.size) {
        dispatchTasks(job);
        finishIteration(job);
      } else advanceBarrier(job);
      if (job.snapshot.status === "running") emit(job);
    },
    async cancel(id) {
      if (!job || job.snapshot.id !== id) return;
      generation++;
      if (["running", "paused"].includes(job.snapshot.status)) stop("cancelled", "user", true);
      else {
        job.snapshot.status = "cancelled";
        job.snapshot.reason = "user";
        emit(job);
        void terminateWorkers();
      }
      await terminating;
    },
    async close() {
      if (closed) return terminating;
      generation++;
      closed = true;
      if (job && ["running", "paused"].includes(job.snapshot.status)) {
        freezeTime(job);
        job.snapshot.status = "cancelled";
        job.snapshot.reason = "closed";
        job.preparation++;
        if (!job.prepared && job.snapshot.focus) {
          job.snapshot.focus.status = "cancelled";
          job.snapshot.focus.reason = "cancelled";
        }
        emit(job);
      }
      await terminateWorkers(true);
    },
  };
}
