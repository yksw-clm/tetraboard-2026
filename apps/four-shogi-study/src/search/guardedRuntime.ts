import {
  createStudySearchRuntime,
  type StudySearchRuntime,
  type StudySearchRuntimeConfig,
  type StudySearchSnapshot,
} from "./runtime";
import { runLethalGuard, type LethalGuardOptions } from "./lethalGuard";
import type { AnalysisPosition } from "@tetraboard/four-shogi/analysis";
import type { StudyCandidate } from "@tetraboard/four-shogi/study-search";
import { encodeAction } from "../../../../packages/four-shogi/src/actionEncoding";

/** OFFでは元runtimeそのものを返します。明示的な有限時間検討だけに後段の検査を加えます。 */
export function createGuardedStudySearchRuntime(
  config: StudySearchRuntimeConfig = {},
  guard: LethalGuardOptions = { mode: "off" },
): StudySearchRuntime {
  if (guard.mode === "off") return createStudySearchRuntime(config);
  let position: AnalysisPosition | null = null,
    shallow: readonly StudyCandidate[] = [];
  let current: {
    id: string | null;
    phase: "search" | "guard" | "done";
    controller: AbortController;
    view: StudySearchSnapshot | null;
    timer: ReturnType<typeof setTimeout> | null;
    budgetStop: boolean;
    bypass: boolean;
    notify: (s: StudySearchSnapshot) => void;
    started: number;
    deadline: number;
  } | null = null;
  const history = new Map<string, StudySearchSnapshot>();
  const base = createStudySearchRuntime({
    ...config,
    onPreparedPosition: (p) => {
      position = p;
      config.onPreparedPosition?.(p);
    },
    onCompletedRoots: (c, d) => {
      if (d === 1) shallow = c;
      config.onCompletedRoots?.(c, d);
    },
  });
  const abort = () => {
    if (!current) return;
    current.controller.abort();
    clearTimeout(current.timer ?? undefined);
  };
  return {
    async start(input, options, callback = () => {}) {
      abort();
      current = null;
      if (options.timeBudgetMs === null || options.focusSide)
        return base.start(input, options, callback);
      const total = options.timeBudgetMs,
        reserve = guard.budgetMs ?? 250;
      if (
        !Number.isFinite(total) ||
        !Number.isFinite(reserve) ||
        total < 1 ||
        reserve < 0 ||
        reserve + 10 >= total
      )
        throw Error("検査予算と終了余裕10msを含む有限の思考時間が必要です");
      shallow = [];
      position = null;
      const started = performance.now();
      const job = {
        id: null as string | null,
        phase: "search" as "search" | "guard" | "done",
        controller: new AbortController(),
        view: null as StudySearchSnapshot | null,
        timer: null as ReturnType<typeof setTimeout> | null,
        budgetStop: false,
        bypass: false,
        notify: callback,
        started,
        deadline: started + total,
      };
      current = job;
      const publish = (s: StudySearchSnapshot) => {
        if (current !== job || job.controller.signal.aborted) return;
        job.view = s;
        callback(s);
      };
      const finish = async (s: StudySearchSnapshot) => {
        if (current !== job || job.phase !== "search" || job.controller.signal.aborted) return;
        job.phase = "guard";
        const operation = job.controller;
        clearTimeout(job.timer ?? undefined);
        publish({ ...s, status: "running", reason: "lethal_guard" });
        try {
          if (!position || s.analysisStateHash !== position.stateHash)
            throw Error("検査元局面が一致しません");
          const report = await runLethalGuard(position, s.candidates, shallow, guard, {
            deadline: job.deadline - 10,
            signal: operation.signal,
          });
          if (current !== job || job.controller !== operation || operation.signal.aborted) return;
          report.normalElapsedMs = performance.now() - started - report.elapsedMs;
          report.totalBudgetMs = total;
          report.maxNCompletedDepth = s.completedDepth;
          const chosen = report.changed
            ? report.rows.find(
                (row) =>
                  row.candidate &&
                  report.hypotheticalAction &&
                  encodeAction(row.action) === encodeAction(report.hypotheticalAction),
              )?.candidate
            : null;
          const candidates = chosen
            ? [
                chosen,
                ...s.candidates.filter(
                  (row) =>
                    encodeAction(row.action) !== encodeAction(chosen.action) &&
                    row.completedDepth === chosen.completedDepth,
                ),
              ]
            : s.candidates;
          const result: StudySearchSnapshot = {
            ...s,
            diagnostics: {
              ...s.diagnostics,
              searchVersion: s.diagnostics.searchVersion + "-guard-" + guard.mode,
            },
            lethalGuard: report,
            candidates,
            status: "completed",
            reason: "lethal_guard",
            elapsedMs: performance.now() - started,
            ...(chosen
              ? {
                  completedDepth: chosen.completedDepth,
                  coverage: chosen.completedDepth === s.completedDepth ? s.coverage : undefined,
                  evaluation: chosen.evaluation,
                  recommendedAction: chosen.action,
                  analysisRecommendedAction: chosen.action,
                }
              : {}),
          };
          job.phase = "done";
          history.set(s.id, result);
          if (history.size > 4) history.delete(history.keys().next().value!);
          publish(result);
        } catch (error) {
          job.phase = "done";
          publish({
            ...s,
            status: "error",
            reason: String(error),
            elapsedMs: performance.now() - started,
          });
        }
      };
      const id = await base.start(
        input,
        {
          ...options,
          broadDepth: options.broadDepth ?? (total < 2000 ? 2 : 3),
          timeBudgetMs: total - reserve - 10,
        },
        (s) => {
          if (current !== job || job.phase !== "search" || job.controller.signal.aborted) return;
          if (job.bypass) {
            publish(s);
            return;
          }
          if (s.status === "completed" || (s.status === "paused" && job.budgetStop)) void finish(s);
          else publish(s);
        },
      );
      job.id = id;
      if (job.phase === "search")
        job.timer = setTimeout(
          () => {
            if (current === job && job.phase === "search") {
              job.budgetStop = true;
              void base.pause(id);
            }
          },
          Math.max(0, job.deadline - reserve - 10 - performance.now()),
        );
      return id;
    },
    get(id) {
      return current?.view?.id === id
        ? structuredClone(current.view)
        : structuredClone(history.get(id) ?? base.get(id));
    },
    async pause(id) {
      if (current?.view?.id === id) {
        const job = current;
        abort();
        job.phase = "done";
        job.view = {
          ...job.view!,
          status: "paused",
          reason: "user",
          elapsedMs: performance.now() - job.started,
        };
        job.notify(job.view);
      }
      await base.pause(id);
    },
    async resume(id) {
      if (current?.view?.id === id) {
        abort();
        current.controller = new AbortController();
        current.bypass = true;
        current.phase = "search";
      }
      await base.resume(id);
    },
    async cancel(id) {
      if (current?.view?.id === id) {
        const job = current;
        abort();
        job.phase = "done";
        job.view = { ...job.view!, status: "cancelled", reason: "user" };
        job.notify(job.view);
      }
      await base.cancel(id);
    },
    async close() {
      abort();
      if (current?.view) {
        current.phase = "done";
        current.view = { ...current.view, status: "cancelled", reason: "closed" };
        current.notify(current.view);
      }
      await base.close();
    },
  };
}
