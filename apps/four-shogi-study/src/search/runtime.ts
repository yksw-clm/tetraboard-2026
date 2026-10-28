import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  compareStudyCandidates,
  evaluateStudyPosition,
  selectStudyRootIndices,
  selectStudyIterationRoots,
  studySearchVersion,
  adaptiveStudySearchVersion,
  legacyStudySearchVersion,
  type StudyCandidate,
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
    transitionCacheHits: number;
    evaluationCacheHits: number;
    iterationDepth: number;
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
export type StudySearchRuntimeConfig = {
  scheduling?: "fixed" | "dynamic";
  threads?: number;
  memoryMb?: number;
  workerScript?: URL;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  cpuProfileDirectory?: string;
};
type Lane = { snapshot: StudyLaneSnapshot; memoryBytes: number; barrier: boolean };
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
    inflight: Map<number, { index: number; taskId: number }>;
    results: Map<number, StudyCandidate>;
    all: Map<number, StudyCandidate>;
    material: Set<number>;
    owners: Map<number, number>;
    waiting: number[];
    waitMs: number[];
    depths: { depth: number; elapsedMs: number; roots: number }[];
    total: number;
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

  let children: ChildProcess[] = [];
  let starting: Promise<void> | null = null;
  let terminating = Promise.resolve();
  let generation = 0;
  let closed = false;
  let job: Job | null = null;
  const history = new Map<string, StudySearchSnapshot>();

  function exited(child: ChildProcess) {
    return child.exitCode !== null || child.signalCode !== null;
  }
  function elapsed(value: Job) {
    return (
      value.consumed + (value.snapshot.status === "running" ? performance.now() - value.started : 0)
    );
  }
  function snapshot(value: Job): StudySearchSnapshot {
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
  function command(message: SearchCommand) {
    for (const child of children) {
      if (!child.connected) continue;
      child.send(message, (error) => {
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
    if (discard) void terminateWorkers();
    else command({ type: "pause", id: job.snapshot.id });
    emit(job);
  }
  function merge(value: Job) {
    const lanes = value.lanes.filter((entry): entry is Lane => entry !== null);
    value.snapshot.work = lanes.reduce((sum, entry) => sum + entry.snapshot.stats.work, 0);
    value.snapshot.nodes = lanes.reduce((sum, entry) => sum + entry.snapshot.stats.nodes, 0);
    value.snapshot.memoryBytes = lanes.reduce((sum, entry) => sum + entry.memoryBytes, 0);
    if (lanes.some((entry) => entry.snapshot.performance)) {
      const sum = (key: keyof StudySearchPerformance) =>
        lanes.reduce((n, entry) => n + (entry.snapshot.performance?.[key] ?? 0), 0);
      value.snapshot.performance = {
        legalMs: sum("legalMs"),
        transitionMs: sum("transitionMs"),
        evaluationMs: sum("evaluationMs"),
        orderingMs: sum("orderingMs"),
        cacheEvictions: sum("cacheEvictions"),
        branchCacheHits: sum("branchCacheHits"),
        branchCacheEntries: sum("branchCacheEntries"),
        keyMs: sum("keyMs"),
        immediateWork: sum("immediateWork"),
        materialWork: sum("materialWork"),
        reducedNodes: sum("reducedNodes"),
        researches: sum("researches"),
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
    children.forEach((child, lane) =>
      child.send(
        {
          type: "start",
          id: value.snapshot.id,
          input,
          options: {
            ...rootOptions,
            strategy: value.dynamic ? (value.options.strategy ?? "adaptive") : "legacy",
            cacheSize:
              rootOptions.cacheSize ??
              (value.dynamic
                ? Math.min(8192, Math.max(256, Math.floor((memoryMb / threads) * 4)))
                : 1024),
            lane,
            lanes: threads,
          },
        } satisfies SearchCommand,
        (error) => {
          if (error && job === value) stop("error", "探索を開始できませんでした", true);
        },
      ),
    );
  }
  function dispatchTasks(value: Job) {
    const dynamic = value.dynamic;
    if (!dynamic || value.snapshot.status !== "running") return;
    children.forEach((child, worker) => {
      if (dynamic.inflight.has(worker) || !dynamic.queue.length) return;
      const preferred = dynamic.queue.findIndex((index) => dynamic.owners.get(index) === worker);
      const [index] = dynamic.queue.splice(preferred < 0 ? 0 : preferred, 1);
      dynamic.waitMs[worker] += Math.max(0, elapsed(value) - dynamic.waiting[worker]);
      const taskId = ++dynamic.nextTaskId;
      dynamic.inflight.set(worker, { index, taskId });
      dynamic.owners.set(index, worker);
      child.send(
        {
          type: "task",
          id: value.snapshot.id,
          taskId,
          index,
          depth: dynamic.depth,
          material: dynamic.depth === 2 && dynamic.material.has(index),
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
        } satisfies SearchCommand,
        (error) => {
          if (error && job === value) stop("error", "探索タスクを送れませんでした", true);
        },
      );
    });
  }
  function beginIteration(value: Job) {
    const dynamic = value.dynamic!;
    const dual = dynamic.dual;
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
    dynamic.total = dynamic.queue.length;
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
      dynamic.results.size !== dynamic.total
    )
      return;
    const dual = dynamic.dual;
    const completed = [...dynamic.results.values()];
    const publish = !dual || dynamic.depth >= value.snapshot.completedDepth;
    if (publish) {
      value.published = completed;
      value.snapshot.completedDepth = dynamic.depth;
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
    if (message.taskId !== undefined && value.dynamic) {
      const dynamic = value.dynamic;
      const assignment = dynamic.inflight.get(index);
      if (!assignment || assignment.taskId !== message.taskId) return;
      value.lanes[index] = {
        snapshot: message.snapshot,
        memoryBytes: message.memoryBytes,
        barrier: message.barrier,
      };
      if (message.barrier) {
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
                  if (message.type === "ready") {
                    clearTimeout(timer);
                    resolve();
                  } else receive(index, message);
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
      else await terminateWorkers();
      const position = await restoreStudyPosition(input);
      if (closed || token !== generation) throw new Error("探索の開始が取り消されました");
      await ensureWorkers();
      if (closed || token !== generation) throw new Error("探索の開始が取り消されました");
      const staticEvaluation = evaluateStudyPosition(position);
      const fallback = getAnalysisLegalActions(position)[0] ?? null;
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
                results: new Map(),
                all: new Map(),
                material: new Set(),
                owners: new Map(),
                waiting: Array(threads).fill(0),
                waitMs: Array(threads).fill(0),
                depths: [],
                total: 0,
                ...(options.strategy === "dual"
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
                : options.strategy === "dual"
                  ? studySearchVersion
                  : adaptiveStudySearchVersion,
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
