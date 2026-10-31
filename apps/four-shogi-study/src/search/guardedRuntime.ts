import {
  createStudySearchRuntime,
  type StudySearchRuntime,
  type StudySearchRuntimeConfig,
  type StudySearchSnapshot,
} from "./runtime";
import { runLethalGuard, type LethalGuardOptions, type LethalGuardReport } from "./lethalGuard";
import type { AnalysisPosition } from "@tetraboard/four-shogi/analysis";
import type { StudyCandidate } from "@tetraboard/four-shogi/study-search";
import { encodeAction } from "../../../../packages/four-shogi/src/actionEncoding";
import { createStudyDeadline } from "./deadline";

/** OFFは通常runtime、有限時間の明示的なガードだけを同じ親時計の期限で包みます。 */
export function createGuardedStudySearchRuntime(
  config: StudySearchRuntimeConfig = {},
  guard: LethalGuardOptions = { mode: "off" },
): StudySearchRuntime {
  if (guard.mode === "off") return createStudySearchRuntime(config);
  type Job = {
    id: string | null;
    phase: "search" | "guard" | "done";
    controller: AbortController;
    view: StudySearchSnapshot | null;
    normal: StudySearchSnapshot | null;
    position: AnalysisPosition | null;
    shallow: readonly StudyCandidate[];
    timer: ReturnType<typeof setTimeout> | null;
    bypass: boolean;
    notify: (s: StudySearchSnapshot) => void;
    deadline: ReturnType<typeof createStudyDeadline>;
    total: number;
  };
  let current: Job | null = null;
  const history = new Map<string, StudySearchSnapshot>();
  const trace = (stage: string, id: string | null, durationMs?: number, reason?: string) =>
    config.observeLifecycle?.({
      clock: "parent-monotonic",
      stage,
      id,
      atMs: performance.now(),
      durationMs,
      reason,
    });
  const base = createStudySearchRuntime({
    ...config,
    onPreparedPosition: (p) => {
      if (current?.phase === "search") current.position = p;
      config.onPreparedPosition?.(p);
    },
    onCompletedRoots: (c, d) => {
      if (current?.phase === "search" && d === 1) current.shallow = c;
      config.onCompletedRoots?.(c, d);
    },
  });
  const abort = (job: Job) => {
    job.controller.abort();
    clearTimeout(job.timer ?? undefined);
    job.timer = null;
  };
  const publish = (job: Job, view: StudySearchSnapshot) => {
    if (current !== job) return;
    job.view = view;
    history.set(view.id, view);
    while (history.size > 4) history.delete(history.keys().next().value!);
    const copying = performance.now();
    const output = structuredClone(view);
    trace("guard-snapshot-copy", view.id, performance.now() - copying);
    const notifying = performance.now();
    try {
      job.notify(output);
    } finally {
      trace("guard-callback", view.id, performance.now() - notifying);
    }
  };
  const finish = (job: Job, cause: string, report?: LethalGuardReport, detail?: string) => {
    if (current !== job || job.phase === "done" || !job.normal) return;
    const started = performance.now();
    const normal = job.normal;
    const late = started >= job.deadline.workUntil;
    const failed = cause === "guard_error" || cause === "guard_timeout" || late;
    if (failed && report) report = { ...report, changed: false };
    const chosen =
      !failed && report?.changed
        ? report.rows.find(
            (row) =>
              row.candidate &&
              report.hypotheticalAction &&
              encodeAction(row.action) === encodeAction(report.hypotheticalAction),
          )?.candidate
        : null;
    const available = normal.completedDepth > 0 && normal.candidates.length > 0;
    const result: StudySearchSnapshot = {
      ...normal,
      diagnostics: report
        ? {
            ...normal.diagnostics,
            searchVersion: normal.diagnostics.searchVersion + "-guard-" + guard.mode,
          }
        : normal.diagnostics,
      lethalGuard: report,
      status: "completed",
      reason:
        cause === "guard_error"
          ? cause
          : failed
            ? "guard_timeout"
            : report
              ? "lethal_guard"
              : "deadline",
      elapsedMs: performance.now() - job.deadline.startedAt,
      completion: {
        normalResult: available ? "complete" : "incomplete",
        cause: failed
          ? cause === "guard_error"
            ? "guard_error"
            : "budget"
          : report
            ? "guard"
            : "budget",
        guard: cause === "guard_error" ? "error" : failed || !report ? "timeout" : "complete",
        budgetMs: job.total,
        finalizedMs: performance.now() - job.deadline.startedAt,
        overdueMs: Math.max(0, performance.now() - job.deadline.endsAt),
        ...(detail ? { detail } : {}),
      },
      ...(chosen
        ? {
            candidates: [
              chosen,
              ...normal.candidates.filter(
                (row) =>
                  encodeAction(row.action) !== encodeAction(chosen.action) &&
                  row.completedDepth === chosen.completedDepth,
              ),
            ],
            completedDepth: chosen.completedDepth,
            coverage: chosen.completedDepth === normal.completedDepth ? normal.coverage : undefined,
            evaluation: chosen.evaluation,
            recommendedAction: chosen.action,
            analysisRecommendedAction: chosen.action,
          }
        : {}),
    };
    job.phase = "done";
    abort(job);
    trace("guard-finalize", normal.id, performance.now() - started, result.reason ?? undefined);
    publish(job, result);
  };
  const inspect = async (job: Job, normal: StudySearchSnapshot) => {
    if (current !== job || job.phase !== "search" || job.controller.signal.aborted) return;
    job.normal = normal;
    if (!normal.candidates.length || performance.now() >= job.deadline.workUntil) {
      finish(job, "guard_timeout");
      return;
    }
    job.phase = "guard";
    publish(job, { ...normal, status: "running", reason: "lethal_guard", completion: undefined });
    if (job.controller.signal.aborted || current !== job || job.phase !== "guard") return;
    const started = performance.now();
    trace("guard-start", normal.id);
    try {
      if (!job.position || normal.analysisStateHash !== job.position.stateHash)
        throw Error("検査元局面が一致しません");
      const report = await runLethalGuard(job.position, normal.candidates, job.shallow, guard, {
        deadline: job.deadline.workUntil - 15,
        signal: job.controller.signal,
      });
      trace("finite-proof-end", normal.id, performance.now() - started);
      if (current !== job || job.phase !== "guard" || job.controller.signal.aborted) return;
      report.normalElapsedMs = started - job.deadline.startedAt;
      report.totalBudgetMs = job.total;
      report.maxNCompletedDepth = normal.completedDepth;
      finish(job, "lethal_guard", report);
    } catch (error) {
      if (current === job && job.phase === "guard" && !job.controller.signal.aborted)
        finish(job, "guard_error", undefined, String(error));
    }
  };
  return {
    async start(input, options, callback = () => {}) {
      if (options.evaluationModel)
        throw new Error("学習モデルと致命応手ガードの併用は未検証です。ガードをOFFにしてください");
      if (current) abort(current);
      current = null;
      if (options.timeBudgetMs === null || options.focusSide)
        return base.start(input, options, callback);
      const total = options.timeBudgetMs,
        reserve = guard.budgetMs ?? 250;
      const deadline = createStudyDeadline(total, options.deadlineAt);
      if (
        !Number.isFinite(total) ||
        !Number.isFinite(reserve) ||
        total < 1 ||
        reserve < 0 ||
        reserve + deadline.settlementMs >= total
      )
        throw Error("検査予算と結果確定の終了余裕を含む有限の思考時間が必要です");
      const job: Job = {
        id: null,
        phase: "search",
        controller: new AbortController(),
        view: null,
        normal: null,
        position: null,
        shallow: [],
        timer: null,
        bypass: false,
        notify: callback,
        deadline,
        total,
      };
      current = job;
      job.timer = setTimeout(
        () => {
          if (current === job && job.phase === "guard") finish(job, "guard_timeout");
        },
        Math.max(0, deadline.workUntil - performance.now()),
      );
      try {
        const id = await base.start(
          input,
          {
            ...options,
            broadDepth: options.broadDepth ?? (total < 2000 ? 2 : 3),
            timeBudgetMs: total - reserve - deadline.settlementMs,
            deadlineAt: deadline.workUntil - reserve,
          },
          (s) => {
            if (current !== job || job.phase !== "search" || job.controller.signal.aborted) return;
            job.id = s.id;
            if (job.bypass) {
              publish(job, s);
              return;
            }
            if (
              s.reason === "memory_limit" ||
              s.status === "error" ||
              s.status === "cancelled" ||
              s.status === "paused"
            ) {
              job.phase = "done";
              abort(job);
              publish(job, s);
            } else if (s.status === "completed") void inspect(job, s);
            else publish(job, s);
          },
        );
        job.id = id;
        return id;
      } catch (error) {
        abort(job);
        throw error;
      }
    },
    get(id) {
      const before = performance.now();
      const owned = current?.view?.id === id ? current.view : history.get(id);
      const result = owned ? structuredClone(owned) : base.get(id);
      trace("guard-get-copy", id, performance.now() - before);
      return result;
    },
    async pause(id) {
      const job = current;
      if (job?.view?.id === id && job.phase !== "done") {
        abort(job);
        job.phase = "done";
        publish(job, {
          ...job.view,
          status: "paused",
          reason: "user",
          elapsedMs: performance.now() - job.deadline.startedAt,
        });
      }
      await base.pause(id);
    },
    async resume(id) {
      const job = current;
      if (job?.view?.id === id) {
        abort(job);
        job.controller = new AbortController();
        job.bypass = true;
        job.phase = "search";
      }
      await base.resume(id);
    },
    async cancel(id) {
      const job = current;
      if (job?.view?.id === id) {
        abort(job);
        job.phase = "done";
        publish(job, { ...job.view, status: "cancelled", reason: "user" });
      }
      await base.cancel(id);
    },
    async close() {
      if (current) {
        const job = current;
        abort(job);
        job.phase = "done";
        if (job.view?.status === "running" || job.view?.status === "paused")
          publish(job, { ...job.view, status: "cancelled", reason: "closed" });
      }
      await base.close();
    },
  };
}
