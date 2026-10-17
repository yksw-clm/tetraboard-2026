import type {
  AiCandidate,
  AiControl,
  AiEvaluation,
  AiProgress,
  AiSearchSettings,
  AiSearchStats,
  AiStopReason,
} from "./aiTypes";
import { AiModelFailure } from "./aiModel";

export type AiSession = {
  steps: Generator<number, void>;
  stats: AiSearchStats;
  staticEvaluation: AiEvaluation;
  results: (cutoff?: boolean) => { candidates: AiCandidate[]; comparedAction: AiCandidate | null };
  readonly doneReason: AiStopReason;
  hasPendingModel?: () => boolean;
  fulfillModel?: (remainingMs: number | null, control: AiControl) => Promise<void>;
};
export function createAiClock(readTime: () => number = () => performance.now()) {
  let last = -Infinity;
  return () => {
    const value = readTime();
    if (!Number.isFinite(value) || value < last)
      throw new TypeError("時計は単調な有限ミリ秒を返してください");
    last = value;
    return value;
  };
}

/** 共通APIと内部の局面実験で、同じ中断点・操作量・壁時計制限を使います。 */
export async function runAiSession(
  session: AiSession,
  settings: AiSearchSettings,
  control: AiControl,
  started: number,
  now: () => number,
  notify?: (progress: AiProgress) => void,
) {
  const yieldToHost =
    control.yieldToHost ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  let yields = 0;
  let lastYieldWork = 0;
  let lastYieldTime = now();
  let notifiedDepth = -1;
  let reason: AiStopReason | null = null;
  function progress(): AiProgress {
    return {
      ...session.stats,
      elapsedMs: now() - started,
      candidates: session.results().candidates,
    };
  }
  function interrupted(): AiStopReason | null {
    const elapsed = now() - started;
    if (control.signal?.aborted || control.isCancelled?.()) return "cancelled";
    if (settings.timeBudgetMs !== null && elapsed >= settings.timeBudgetMs) return "deadline";
    return null;
  }
  try {
    if (session.doneReason !== "terminal" && session.stats.generatedMoves > 0) {
      for (let step = session.steps.next(); !step.done; step = session.steps.next()) {
        reason = interrupted();
        if (reason !== null) break;
        if (session.stats.work + step.value > settings.maxWork) {
          reason = "work_limit";
          break;
        }
        if (session.hasPendingModel?.()) {
          await session.fulfillModel!(
            settings.timeBudgetMs === null
              ? null
              : Math.max(0, settings.timeBudgetMs - (now() - started)),
            control,
          );
          reason = interrupted();
          if (reason !== null) break;
        }
        if (session.stats.completedDepth !== notifiedDepth) {
          notifiedDepth = session.stats.completedDepth;
          notify?.(progress());
          reason = interrupted();
          if (reason !== null) break;
        }
        if (session.stats.work - lastYieldWork >= 128 || now() - lastYieldTime >= 8) {
          notify?.(progress());
          await yieldToHost();
          yields++;
          lastYieldWork = session.stats.work;
          lastYieldTime = now();
          reason = interrupted();
          if (reason !== null) break;
        }
      }
    }
  } catch (error) {
    if (
      error instanceof AiModelFailure &&
      (error.reason === "cancelled" || error.reason === "deadline")
    )
      reason = error.reason;
    else throw error;
  } finally {
    session.steps.return();
  }
  reason ??= session.doneReason;
  const cutoff = reason === "work_limit" || reason === "deadline" || reason === "cancelled";
  return { reason, cutoff, yields, ...session.results(cutoff) };
}
