import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  compareStudyCandidates,
  evaluateStudyPosition,
  selectStudyRootIndices,
  studySearchVersion,
  type StudyCandidate,
  type StudyLaneSnapshot,
  type StudyProfile,
} from "@tetraboard/four-shogi/study-search";
import type { AiCandidate, AiEvaluation } from "@tetraboard/four-shogi/ai";
import type { FourShogiAction, Side } from "@tetraboard/four-shogi";
import { getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";
import { restoreStudyPosition } from "../domain/study";
import type { StudyPositionInput } from "../shared/model";
import type { SearchCommand, SearchMessage } from "./messages";

export type StudySearchSnapshot = {
  id: string;
  stateHash: string;
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
  evaluation: AiEvaluation | null;
  staticEvaluation: AiEvaluation;
  workers: number;
  diagnostics: {
    searchVersion: string;
    profile: StudyProfile;
    selectedRoots: number;
    legalRoots: number;
    safetyComplete: boolean;
  };
};
export type StudySearchOptions = {
  timeBudgetMs: number | null;
  maxDepth?: number;
  profile?: StudyProfile;
  width?: number;
  rootWidth?: number;
  extensions?: number;
  dangerWork?: number;
};
export type StudySearchRuntimeConfig = {
  threads?: number;
  memoryMb?: number;
  workerScript?: URL;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};
type Lane = { snapshot: StudyLaneSnapshot; memoryBytes: number; barrier: boolean };
type Job = {
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
    if (discard) void terminateWorkers();
    else command({ type: "pause", id: job.snapshot.id });
    emit(job);
  }
  function merge(value: Job) {
    const lanes = value.lanes.filter((entry): entry is Lane => entry !== null);
    value.snapshot.work = lanes.reduce((sum, entry) => sum + entry.snapshot.stats.work, 0);
    value.snapshot.nodes = lanes.reduce((sum, entry) => sum + entry.snapshot.stats.nodes, 0);
    value.snapshot.memoryBytes = lanes.reduce((sum, entry) => sum + entry.memoryBytes, 0);
    const root = value.snapshot.rootSide;
    if (root) {
      const merged = value.published
        .map((candidate) => {
          const proof = value.proofs.get(candidate.rootIndex);
          return proof
            ? {
                ...candidate,
                study: proof.study,
                danger: { ...candidate.danger, alternatives: proof.danger.alternatives },
              }
            : candidate;
        })
        .sort((a, b) => compareStudyCandidates(a, b, root));
      value.snapshot.candidates = merged.slice(0, 5);
      value.snapshot.recommendedAction = merged[0]?.action ?? value.snapshot.recommendedAction;
      value.snapshot.evaluation = merged[0]?.evaluation ?? null;
      value.snapshot.diagnostics.safetyComplete =
        merged.length > 0 && merged.every((entry) => entry.study.immediateRepliesComplete);
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
    }
    const soleWin =
      value.snapshot.candidates[0]?.evaluation?.evaluationKind === "terminal" &&
      value.snapshot.rootSide !== null &&
      value.snapshot.candidates[0].evaluation.values[value.snapshot.rootSide].primary === 1;
    if (allDone || soleWin) {
      stop("completed", soleWin ? "sole_win" : depth === 0 ? "terminal" : "max_depth", true);
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
    const previous = value.lanes[index];
    if (previous && message.snapshot.depth < previous.snapshot.depth) return;
    if (message.barrier && !message.snapshot.done && message.snapshot.depth <= value.releasedDepth)
      return;
    value.lanes[index] = {
      snapshot: message.snapshot,
      memoryBytes: message.memoryBytes,
      barrier: message.barrier,
    };
    for (const candidate of message.snapshot.candidates)
      value.proofs.set(candidate.rootIndex, { study: candidate.study, danger: candidate.danger });
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
                const child = spawn(process.execPath, ["--no-env-file", workerPath], {
                  stdio: ["ignore", "ignore", "pipe", "ipc"],
                });
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
      const id = crypto.randomUUID();
      job = {
        snapshot: {
          id,
          stateHash: position.stateHash,
          rootSide: position.state.turn,
          status: "running",
          reason: null,
          elapsedMs: 0,
          completedDepth: 0,
          work: 0,
          nodes: 0,
          memoryBytes: 0,
          candidates: [],
          recommendedAction: fallback,
          evaluation: position.state.status === "finished" ? staticEvaluation : null,
          staticEvaluation,
          workers: threads,
          diagnostics: {
            searchVersion: studySearchVersion,
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
      };
      const { timeBudgetMs, ...rootOptions } = options;
      children.forEach((child, lane) =>
        child.send(
          {
            type: "start",
            id,
            input,
            options: { ...rootOptions, lane, lanes: threads },
          } satisfies SearchCommand,
          (error) => {
            if (error && job?.snapshot.id === id) stop("error", "探索を開始できませんでした", true);
          },
        ),
      );
      if (timeBudgetMs !== null) {
        const value = job;
        value.timer = setTimeout(() => {
          if (job === value) stop("completed", "deadline", false);
        }, timeBudgetMs);
      }
      emit(job);
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
        ["memory_limit", "terminal", "max_depth", "sole_win"].includes(job.snapshot.reason ?? "")
      )
        return;
      job.snapshot.status = "running";
      job.snapshot.reason = null;
      job.started = performance.now();
      // 継続は既存の読みを保つ無制限解析です。時間を指定し直す場合は新しく開始します。
      command({ type: "resume", id });
      advanceBarrier(job);
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
        emit(job);
      }
      await terminateWorkers(true);
    },
  };
}
