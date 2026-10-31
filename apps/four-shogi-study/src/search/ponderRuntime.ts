import { getActiveSides, sides } from "@tetraboard/four-shogi";
import {
  advanceAnalysisPosition,
  getAnalysisLegalActions,
  type AnalysisPosition,
} from "@tetraboard/four-shogi/analysis";
import { evaluateStudyPosition, studyStrategyVersion } from "@tetraboard/four-shogi/study-search";
import { restoreStudyPosition } from "../domain/study";
import type { StudyPositionInput } from "../shared/model";
import {
  createStudySearchRuntime,
  type StudySearchRuntime,
  type StudySearchRuntimeConfig,
  type StudySearchOptions,
  type StudySearchSnapshot,
} from "./runtime";
import { createPvFocusRuntime, focusConditions, focusBroadDepth } from "./focusRuntime";
import { createStudyDeadline } from "./deadline";
export type FocusPonderOptions = {
  mode: "ponder" | "combined";
  ponderMs?: number;
  ttlMs?: number;
  cacheEntries?: number;
};
const copy = <T>(x: T): T => structuredClone(x);
const playerKey = (p: AnalysisPosition) => JSON.stringify(sides.map((s) => p.state.players[s]));
const workerTotals = (s: StudySearchSnapshot | null) => ({
  cpu: (s?.timing?.workers ?? []).reduce((n, w) => n + (w?.cpuMs ?? 0), 0),
  active: (s?.timing?.workers ?? []).reduce((n, w) => n + (w?.activeMs ?? 0), 0),
});
/** 同じ予測終点・根文脈のsessionだけを保持し、別の根へ評価や枝を移植しません。 */
export function createPonderFocusRuntime(
  config: StudySearchRuntimeConfig = {},
  options: FocusPonderOptions = { mode: "ponder" },
): StudySearchRuntime {
  const ponderMs = options.ponderMs ?? 1000,
    ttlMs = options.ttlMs ?? 30000,
    cacheEntries = options.cacheEntries ?? 1024;
  if (
    !Number.isFinite(ponderMs) ||
    ponderMs < 1 ||
    ponderMs > 60000 ||
    !Number.isFinite(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 300000 ||
    !Number.isSafeInteger(cacheEntries) ||
    cacheEntries < 0 ||
    cacheEntries > 65536
  )
    throw Error("先読みの予算・保持期限・キャッシュ上限が不正です");
  // 同じ予測終点のresumeはworkerも保持する。新しい根のstartでは、完成済みの
  // 探索から高いRSSを持ち越さないよう既存runtimeのpool再利用を既定で止める。
  const nativeConfig = {
    ...config,
    measureStages: true,
    reuseWorkers: config.reuseWorkers ?? false,
  };
  const inner =
    options.mode === "combined"
      ? createPvFocusRuntime(nativeConfig, { keepSearchOnHold: true })
      : createStudySearchRuntime(nativeConfig);
  type Session = {
    id: string | null;
    key: string;
    source: AnalysisPosition;
    last: StudySearchSnapshot | null;
    dead: boolean;
    route: Map<string, number>;
    routeTask: Promise<void> | null;
    matched: number;
    ponderWork: number;
    ponderCpu: number;
    ttl: ReturnType<typeof setTimeout> | null;
  };
  type Job = {
    input: StudyPositionInput;
    budget: number;
    unlimited: boolean;
    id: string;
    session: Session;
    source: AnalysisPosition;
    offset: number;
    hit: boolean;
    phase: "ponder" | "foreground";
    priorWork: number;
    priorNodes: number;
    priorDepth: number;
    priorBranchEntries: number;
    priorCpu: number;
    priorActive: number;
    started: number;
    deadline: ReturnType<typeof createStudyDeadline>;
    timer: ReturnType<typeof setTimeout> | null;
    done: boolean;
    view: StudySearchSnapshot;
    notify: (s: StudySearchSnapshot) => void;
    options: StudySearchOptions;
  };
  let session: Session | null = null,
    current: Job | null = null,
    closed = false,
    generation = 0;
  let passthroughId: string | null = null;
  const history = new Map<string, StudySearchSnapshot>();
  function blank(p: AnalysisPosition, opts: StudySearchOptions, id: string): StudySearchSnapshot {
    const focus = opts.focusSide!;
    return {
      id,
      stateHash: p.stateHash,
      analysisStateHash: null,
      rootSide: focus,
      status: "running",
      reason: null,
      elapsedMs: 0,
      completedDepth: 0,
      work: 0,
      nodes: 0,
      memoryBytes: 0,
      candidates: [],
      recommendedAction: null,
      analysisRecommendedAction: null,
      evaluation: null,
      staticEvaluation: evaluateStudyPosition(p),
      workers: config.threads ?? 4,
      focus: {
        side: focus,
        status: "preparing",
        reason: null,
        sourceStateHash: p.stateHash,
        analysisStateHash: null,
        prefix: [],
        conditional: p.state.turn !== focus,
        projectionElapsedMs: 0,
        model: null,
        result: null,
      },
      diagnostics: {
        searchVersion: studyStrategyVersion(opts.strategy) + "-focus-" + options.mode,
        profile: opts.profile ?? "study",
        selectedRoots: 0,
        legalRoots: getAnalysisLegalActions(p).length,
        safetyComplete: false,
      },
    };
  }
  function publish(j: Job, s: StudySearchSnapshot) {
    if (current !== j || j.done) return;
    j.view = copy(s);
    history.set(j.id, j.view);
    while (history.size > 4) history.delete(history.keys().next().value!);
    j.notify(copy(j.view));
  }
  function mapped(j: Job, raw: StudySearchSnapshot): StudySearchSnapshot {
    const focus = raw.focus
      ? {
          ...raw.focus,
          sourceStateHash: j.source.stateHash,
          prefix: raw.focus.prefix.slice(j.offset).map((x, i) => ({ ...x, afterPly: i + 1 })),
          projectionElapsedMs: j.hit ? 0 : raw.focus.projectionElapsedMs,
        }
      : null;
    if (focus) focus.conditional = focus.prefix.length > 0;
    const legal =
      raw.analysisStateHash === j.source.stateHash &&
      j.source.state.turn === j.options.focusSide &&
      raw.completedDepth > 0 &&
      !!raw.analysisRecommendedAction &&
      getAnalysisLegalActions(j.source).some(
        (a) => JSON.stringify(a) === JSON.stringify(raw.analysisRecommendedAction),
      );
    const totals = workerTotals(raw),
      work = Math.max(0, raw.work - j.priorWork),
      cpu = Math.max(0, totals.cpu - j.priorCpu);
    return {
      ...raw,
      id: j.id,
      stateHash: j.source.stateHash,
      focus,
      status: "running",
      reason: null,
      completion: undefined,
      elapsedMs: performance.now() - j.started,
      work,
      nodes: Math.max(0, raw.nodes - j.priorNodes),
      recommendedAction: legal ? raw.analysisRecommendedAction : null,
      staticEvaluation: j.view.staticEvaluation,
      ...(j.hit ? { timing: undefined } : {}),
      continuation: {
        mode: options.mode,
        pvHit: raw.continuation?.pvHit ?? false,
        pvEntries: raw.continuation?.pvEntries ?? 0,
        hintReorders: raw.diagnostics.hintReorders ?? 0,
        priorWork: j.priorWork,
        cacheEntryLimit: j.options.cacheSize,
        newWork: work,
        phase: j.phase,
        sessionHit: j.hit,
        matchedPlies: j.offset,
        priorCompletedDepth: j.priorDepth,
        reusedComparison: j.hit && j.priorDepth > 0,
        sessionWork: raw.work,
        ponderWork: j.session.ponderWork + (j.phase === "ponder" ? work : 0),
        workerCpuMs: cpu,
        workerActiveMs: Math.max(0, totals.active - j.priorActive),
        priorPonderCpuMs: j.session.ponderCpu,
        retainedBranchEntries: j.priorBranchEntries,
        branchCacheHits: raw.performance?.branchCacheHits ?? 0,
      },
    };
  }
  async function startPlain(
    input: StudyPositionInput,
    opts: StudySearchOptions,
    notify: (s: StudySearchSnapshot) => void,
  ) {
    const token = generation;
    const id = await inner.start(input, opts, (s) => {
      if (closed || token !== generation) return;
      passthroughId = s.id;
      notify(s);
    });
    if (closed || token !== generation) {
      await inner.cancel(id);
      throw Error("探索の開始が取り消されました");
    }
    passthroughId = id;
    return id;
  }
  function cancelledHistory(j: Job, reason: string) {
    j.view = {
      ...j.view,
      status: "cancelled",
      reason,
      completion: undefined,
      recommendedAction: null,
      analysisRecommendedAction: null,
    };
    history.set(j.id, copy(j.view));
  }
  async function drop(s: Session) {
    if (s.dead) return;
    s.dead = true;
    clearTimeout(s.ttl ?? undefined);
    if (session === s) session = null;
    if (s.id) await inner.cancel(s.id);
  }
  function expire(s: Session) {
    if (s.dead || closed) return;
    clearTimeout(s.ttl ?? undefined);
    s.ttl = setTimeout(() => {
      if (session === s && (!current || current.done)) void drop(s);
    }, ttlMs);
  }
  async function finish(
    j: Job,
    status: "completed" | "paused" | "cancelled" | "error",
    reason: string,
  ) {
    if (current !== j || j.done) return;
    clearTimeout(j.timer ?? undefined);
    j.timer = null;
    let acknowledged = true;
    if (j.session.id) {
      if (inner.pauseAndDrain)
        acknowledged = await inner.pauseAndDrain(
          j.session.id,
          Math.max(1, Math.min(150, j.deadline.endsAt - performance.now() - 10)),
        );
      else await inner.pause(j.session.id);
    }
    if (current !== j || j.done) return;
    const raw = j.session.id ? inner.get(j.session.id) : j.session.last;
    if (raw) j.session.last = raw;
    const view = raw ? mapped(j, raw) : { ...j.view, elapsedMs: performance.now() - j.started };
    if (j.phase === "ponder" && raw) {
      j.session.ponderWork += Math.max(0, raw.work - j.priorWork);
      j.session.ponderCpu += Math.max(0, workerTotals(raw).cpu - j.priorCpu);
    }
    if (!acknowledged) {
      reason = "pause_timeout";
      if (view.continuation) view.continuation.pauseAcknowledged = false;
    } else if (view.continuation) view.continuation.pauseAcknowledged = true;
    const elapsed = performance.now() - j.started;
    const result = {
      ...view,
      status,
      reason,
      ...(status === "cancelled"
        ? { recommendedAction: null, analysisRecommendedAction: null }
        : {}),
      elapsedMs: elapsed,
      completion:
        status === "completed"
          ? {
              normalResult:
                view.completedDepth > 0 && view.candidates.length > 0
                  ? ("complete" as const)
                  : ("incomplete" as const),
              cause: reason === "deadline" ? "budget" : reason,
              budgetMs: j.unlimited ? null : j.budget,
              finalizedMs: elapsed,
              overdueMs: Math.max(0, performance.now() - j.deadline.endsAt),
            }
          : undefined,
    };
    publish(j, result);
    j.done = true;
    j.view = copy(result);
    history.set(j.id, j.view);
    if (
      status === "cancelled" ||
      status === "error" ||
      reason === "memory_limit" ||
      !raw ||
      !acknowledged
    )
      await drop(j.session);
    else expire(j.session);
  }
  async function route(s: Session, raw: StudySearchSnapshot) {
    if (s.routeTask || raw.focus?.status !== "ready") return;
    s.routeTask = (async () => {
      let p = s.source;
      const entries = new Map([[p.stateHash, 0]]);
      for (const [i, x] of raw.focus!.prefix.entries()) {
        p = await advanceAnalysisPosition(p, { type: "action", side: x.side, action: x.action });
        entries.set(p.stateHash, i + 1);
      }
      if (!s.dead && p.stateHash === raw.analysisStateHash && p.state.turn === raw.focus!.side)
        s.route = entries;
    })();
    await s.routeTask;
  }
  const receive = (s: Session, raw: StudySearchSnapshot) => {
    if (s.dead || session !== s) return;
    s.id = raw.id;
    s.last = raw;
    void route(s, raw).catch(() => {
      const j = current;
      if (j?.session === s) void finish(j, "error", "forecast_route_invalid");
    });
    const j = current;
    if (!j || j.session !== s || j.done) return;
    publish(j, mapped(j, raw));
    if (raw.status === "error" || raw.status === "cancelled")
      void finish(j, raw.status, raw.reason ?? raw.status);
    else if (raw.status === "completed") void finish(j, "completed", raw.reason ?? "completed");
  };
  return {
    async start(input, opts, notify = () => {}) {
      if (closed) throw Error("探索は終了しています");
      if (
        !opts.focusSide ||
        opts.strategy !== "dual-continuations" ||
        !opts.sessionKey ||
        opts.timeBudgetMs === null
      ) {
        await this.releaseFocus!();
        return startPlain(input, opts, notify);
      }
      if (
        !Number.isFinite(opts.timeBudgetMs) ||
        opts.timeBudgetMs! < 1 ||
        opts.timeBudgetMs! > 3600000
      )
        throw Error("検討時間は1〜3600000msの有限値が必要です");
      if (
        opts.cacheSize !== undefined &&
        (!Number.isSafeInteger(opts.cacheSize) || opts.cacheSize < 0 || opts.cacheSize > 65536)
      )
        throw Error("cacheSizeは0〜65536の整数が必要です");
      const boundedOptions = {
        ...opts,
        cacheSize: Math.min(opts.cacheSize ?? cacheEntries, cacheEntries),
      };
      const started = performance.now(),
        token = ++generation;
      if (passthroughId) {
        const id = passthroughId;
        passthroughId = null;
        await inner.cancel(id);
      }
      if (current && !current.done) await finish(current, "paused", "position_update");
      const p = await restoreStudyPosition(input);
      if (closed || token !== generation) throw Error("探索の開始が取り消されました");
      if (p.state.status !== "playing" || !getActiveSides(p.state).includes(opts.focusSide)) {
        await this.releaseFocus!();
        return startPlain(input, opts, notify);
      }
      const key = JSON.stringify([
        opts.sessionKey,
        opts.focusSide,
        focusConditions(config, boundedOptions),
        playerKey(p),
      ]);
      let previous = session;
      if (previous?.routeTask) await previous.routeTask;
      if (closed || token !== generation) throw Error("探索の開始が取り消されました");
      const offset = previous?.key === key ? previous.route.get(p.stateHash) : undefined;
      const hit = !!(
        previous &&
        !previous.dead &&
        offset !== undefined &&
        offset >= previous.matched &&
        previous.last?.focus?.status === "ready"
      );
      if (!hit) {
        if (previous) {
          clearTimeout(previous.ttl ?? undefined);
          previous.dead = true;
          if (previous.key !== key) await inner.releaseFocus?.();
        }
        previous = {
          id: null,
          key,
          source: p,
          last: null,
          dead: false,
          route: new Map(),
          routeTask: null,
          matched: 0,
          ponderWork: 0,
          ponderCpu: 0,
          ttl: null,
        };
        session = previous;
      } else {
        clearTimeout(previous!.ttl ?? undefined);
        previous!.matched = offset!;
      }
      const s = previous!;
      const phase = p.state.turn === opts.focusSide ? "foreground" : "ponder";
      const budget =
        phase === "ponder" ? Math.min(opts.timeBudgetMs ?? ponderMs, ponderMs) : opts.timeBudgetMs;
      if (budget === null || !Number.isFinite(budget) || budget < 1)
        throw Error("先読み引継ぎは有限の検討時間が必要です");
      const deadline = createStudyDeadline(budget); // Restore is included by shifting the same parent-clock limits.
      // 停止応答を150msまで待ち、copy/通知へ50ms残す。短い予算では全体の25%を上限にする。
      const settlement = Math.min(200, budget * 0.25);
      deadline.workUntil = Math.min(deadline.workUntil, deadline.endsAt - settlement);
      const pre = performance.now() - started;
      deadline.startedAt -= pre;
      deadline.endsAt -= pre;
      deadline.workUntil -= pre;
      const id = crypto.randomUUID();
      const old = s.last;
      const totals = workerTotals(old);
      const j: Job = {
        input,
        budget,
        unlimited: false,
        id,
        session: s,
        source: p,
        offset: hit ? offset! : 0,
        hit,
        phase,
        priorWork: hit ? (old?.work ?? 0) : 0,
        priorNodes: hit ? (old?.nodes ?? 0) : 0,
        priorDepth: hit ? (old?.completedDepth ?? 0) : 0,
        priorBranchEntries: hit ? (old?.performance?.branchCacheEntries ?? 0) : 0,
        priorCpu: hit ? totals.cpu : 0,
        priorActive: hit ? totals.active : 0,
        started,
        deadline,
        timer: null,
        done: false,
        view: blank(p, opts, id),
        notify,
        options: boundedOptions,
      };
      current = j;
      publish(j, j.view);
      j.timer = setTimeout(
        () => void finish(j, "completed", "deadline"),
        Math.max(0, deadline.workUntil - performance.now()),
      );
      if (hit && s.id) {
        if (old) publish(j, mapped(j, old));
        if (old?.status === "completed" && ["sole_win", "max_depth"].includes(old.reason ?? ""))
          void finish(j, "completed", old.reason!);
        else void inner.resume(s.id).catch((e) => void finish(j, "error", String(e)));
      } else
        void inner
          .start(
            input,
            {
              ...boundedOptions,
              broadDepth: focusBroadDepth(boundedOptions),
              deadlineAt: deadline.endsAt,
              timeBudgetMs: budget,
            },
            (raw) => receive(s, raw),
          )
          .then(async (innerId) => {
            s.id = innerId;
            if (s.dead) await inner.cancel(innerId);
          })
          .catch((e) => {
            if (!s.dead && current === j) void finish(j, "error", String(e));
          });
      return id;
    },
    get(id) {
      const j = current;
      if (j?.id === id) return copy(j.view);
      return copy(history.get(id) ?? inner.get(id));
    },
    async holdFocus(id) {
      const j = current;
      if (j?.id !== id) {
        if (passthroughId === id) {
          passthroughId = null;
          await inner.cancel(id);
        }
        return;
      }
      if (!j.done) await finish(j, "paused", "position_update");
      if (j.session.id && session === j.session) await inner.holdFocus?.(j.session.id);
      expire(j.session);
    },
    async pause(id) {
      if (current?.id === id) await finish(current, "paused", "user");
      else await inner.pause(id);
    },
    async resume(id) {
      const j = current;
      if (j?.id !== id) {
        await inner.resume(id);
        return;
      }
      if (j.session.dead || session !== j.session || !j.session.id) {
        await this.start(j.input, j.options, j.notify);
        return;
      }
      if (j.phase === "ponder") {
        await this.start(j.input, j.options, j.notify);
        return;
      }
      if (["sole_win", "max_depth", "focus_eliminated", "terminal"].includes(j.view.reason ?? ""))
        return;
      clearTimeout(j.session.ttl ?? undefined);
      j.done = false;
      j.unlimited = true;
      j.started = performance.now() - j.view.elapsedMs;
      j.deadline.endsAt = Infinity;
      j.deadline.workUntil = Infinity;
      const raw = inner.get(j.session.id);
      if (raw) publish(j, mapped(j, raw));
      await inner.resume(j.session.id);
    },
    async cancel(id) {
      const j = current;
      if (j?.id === id) {
        if (!j.done) await finish(j, "cancelled", "user");
        cancelledHistory(j, "user");
        await drop(j.session);
        current = null;
      } else if (!history.has(id)) {
        if (passthroughId === id) passthroughId = null;
        await inner.cancel(id);
      }
    },
    async releaseFocus() {
      generation++;
      const j = current;
      if (j && !j.done) await finish(j, "cancelled", "invalidated");
      if (session) await drop(session);
      if (passthroughId) {
        const id = passthroughId;
        passthroughId = null;
        await inner.cancel(id);
      }
      if (j) cancelledHistory(j, "invalidated");
      current = null;
      await inner.releaseFocus?.();
    },
    async close() {
      closed = true;
      await this.releaseFocus!();
      history.clear();
      await inner.close();
    },
  };
}
