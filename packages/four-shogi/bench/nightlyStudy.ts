import {
  createStudySearchRuntime,
  type StudySearchSnapshot,
} from "../../../apps/four-shogi-study/src/search/runtime";
import type { StudyPositionInput } from "../../../apps/four-shogi-study/src/shared/model";
export async function runNativeStudy(
  input: StudyPositionInput,
  model: {
    file: string;
    modelId: string;
    sha256?: string;
    valueOnlyHead?: boolean;
    historyFeatureCache?: boolean;
    historyReferenceCache?: boolean;
  } | null = null,
  timeBudgetMs = 5000,
  threads = 4,
  signal?: AbortSignal,
) {
  const cpuStart = process.cpuUsage(),
    workerCpu = new Map<number, number>(),
    workerRss = new Map<number, number>();
  const runtime = createStudySearchRuntime({
    threads,
    memoryMb: 4096,
    taskPartition: "root",
    measureStages: true,
    reuseWorkers: false,
    observeParallel: (event) => {
      if (event.type === "worker") {
        workerCpu.set(
          event.worker,
          Math.max(workerCpu.get(event.worker) ?? 0, event.processCpuMs ?? 0),
        );
        workerRss.set(event.worker, Math.max(workerRss.get(event.worker) ?? 0, event.rss));
      }
    },
  });
  const started = performance.now();
  let id: string | null = null,
    timer: ReturnType<typeof setTimeout> | undefined;
  let settle: (value: StudySearchSnapshot) => void = () => {},
    fail: (error: Error) => void = () => {};
  let measurement:
    | {
        result: StudySearchSnapshot;
        elapsedMs: number;
        searchElapsedMs: number;
        modelUsed: boolean;
        withinBudget: boolean;
        complete: boolean;
        workerCpuMs: number;
        parentCpuMs: number;
        peakWorkerRssBytes: number;
      }
    | undefined;
  const finished = new Promise<StudySearchSnapshot>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // start()の途中で拒否しても未処理rejectを残さない。
  void finished.catch(() => {});
  const cancel = () => {
    if (id) void runtime.cancel(id);
    fail(new Error("解析を取り消しました"));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) throw new Error("解析を取り消しました");
    timer = setTimeout(
      () => fail(new Error("P0-5の外側応答期限を超えました")),
      timeBudgetMs + 1000,
    );
    id = await runtime.start(
      input,
      {
        strategy: "dual-continuations",
        timeBudgetMs,
        ...(model ? { evaluationModel: model } : {}),
        focusSide: null,
      },
      (snapshot) => {
        if (!["running", "paused"].includes(snapshot.status)) settle(snapshot);
      },
    );
    const result = await finished;
    const elapsedMs = performance.now() - started;
    measurement = {
      workerCpuMs: [...workerCpu.values()].reduce((a, b) => a + b, 0),
      parentCpuMs: 0,
      peakWorkerRssBytes: [...workerRss.values()].reduce((a, b) => a + b, 0),
      result,
      elapsedMs,
      searchElapsedMs: elapsedMs,
      modelUsed: model === null || (result.performance?.modelInferences ?? 0) > 0,
      withinBudget: elapsedMs <= timeBudgetMs,
      complete:
        result.status === "completed" &&
        result.completedDepth > 0 &&
        !!result.recommendedAction &&
        !["memory_limit", "error"].includes(result.reason ?? ""),
    };
    return measurement;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    await runtime.close();
    if (measurement) {
      const used = process.cpuUsage(cpuStart);
      measurement.parentCpuMs = (used.user + used.system) / 1000;
      measurement.elapsedMs = performance.now() - started;
      measurement.withinBudget = measurement.elapsedMs <= timeBudgetMs;
    }
  }
}
