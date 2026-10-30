import {
  advanceAnalysisPosition,
  analysisRuleProfileId,
  type AnalysisPosition,
} from "@tetraboard/four-shogi/analysis";
import { studyStrategyVersion, studyEvaluationVersion } from "@tetraboard/four-shogi/study-search";
import { createFocusHints, type FocusReuseIdentity } from "./focusContinuation";
import {
  createStudySearchRuntime,
  type StudySearchRuntime,
  type StudySearchRuntimeConfig,
  type StudySearchOptions,
  type StudySearchSnapshot,
} from "./runtime";

export function focusConditions(
  config: StudySearchRuntimeConfig,
  options: StudySearchOptions,
): string {
  return JSON.stringify([
    analysisRuleProfileId,
    "analysis-state-v1",
    studyStrategyVersion(options.strategy),
    studyEvaluationVersion,
    options.profile ?? "study",
    options.maxDepth ?? 256,
    options.width ?? 6,
    options.rootWidth ?? 24,
    options.extensions ?? 2,
    options.dangerWork ?? null,
    options.cacheSize ?? null,
    options.broadDepth ?? 3,
    options.reuseChecks ?? true,
    config.threads ?? 4,
    config.memoryMb ?? 8192,
    config.taskPartition ?? "root",
    config.replyCacheBudget ?? "workers",
    config.splitMinDepth ?? 4,
  ]);
}
/** PVは順序ヒントだけで、評価・完成深さ・枝の完成状態を新しい根へ移植しません。 */
export function createPvFocusRuntime(config: StudySearchRuntimeConfig = {}): StudySearchRuntime {
  const hints = createFocusHints();
  type Context = {
    id: string | null;
    source: AnalysisPosition | null;
    identity: FocusReuseIdentity | null;
    pvHit: boolean;
    last: StudySearchSnapshot | null;
  };
  let current: Context | null = null;
  const contexts = new Map<string, Context>();
  const base = createStudySearchRuntime({
    ...config,
    onPreparedPosition: (p) => {
      if (current) {
        current.source = p;
        current.pvHit = !!(current.identity && hints.get(p, current.identity));
      }
      config.onPreparedPosition?.(p);
    },
    rootOrderHint: (p) =>
      current?.identity && current.pvHit ? (hints.get(p, current.identity)?.action ?? null) : null,
  });
  const decorate = (s: StudySearchSnapshot, c: Context): StudySearchSnapshot =>
    c.identity
      ? {
          ...s,
          continuation: {
            mode: "pv",
            pvHit: c.pvHit,
            pvEntries: hints.stats().entries,
            hintReorders: s.diagnostics.hintReorders ?? 0,
            priorWork: 0,
            newWork: s.work,
          },
        }
      : s;
  const capture = async (c: Context) => {
    const s = c.last,
      p = c.source,
      id = c.identity;
    if (!s || !p || !id || s.completedDepth < 1 || s.focus?.status !== "ready") return;
    let target = p;
    for (const step of s.focus.prefix)
      target = await advanceAnalysisPosition(target, {
        type: "action",
        side: step.side,
        action: step.action,
      });
    if (current !== c) return;
    if (target.stateHash !== s.analysisStateHash || target.state.turn !== id.side) return;
    await hints.offer(target, id, s.candidates);
  };
  return {
    async start(input, options, notify = () => {}) {
      const c: Context = {
        id: null,
        source: null,
        identity:
          options.focusSide && options.strategy === "dual-continuations" && options.sessionKey
            ? {
                scope: options.sessionKey,
                side: options.focusSide,
                conditions: focusConditions(config, options),
              }
            : null,
        pvHit: false,
        last: null,
      };
      if (!c.identity || JSON.stringify(c.identity) !== JSON.stringify(current?.identity))
        hints.clear();
      current = c;
      const id = await base.start(input, options, (s) => {
        if (current !== c) return;
        c.id = s.id;
        c.last = s;
        contexts.set(s.id, c);
        while (contexts.size > 4) contexts.delete(contexts.keys().next().value!);
        notify(decorate(s, c));
      });
      c.id = id;
      return id;
    },
    get(id) {
      const s = base.get(id),
        c = contexts.get(id);
      return s && c ? decorate(s, c) : s;
    },
    pause: (id) => base.pause(id),
    pauseAndDrain: (id, timeout) => base.pauseAndDrain!(id, timeout),
    resume: (id) => base.resume(id),
    async holdFocus(id) {
      if (current?.id !== id) return;
      await base.pause(id);
      current.last = base.get(id);
      await capture(current);
    },
    async releaseFocus() {
      hints.clear();
      if (current?.id) await base.cancel(current.id);
      current = null;
    },
    async cancel(id) {
      if (current?.id === id) {
        hints.clear();
        current = null;
      }
      await base.cancel(id);
    },
    async close() {
      hints.clear();
      current = null;
      contexts.clear();
      await base.close();
    },
  };
}
