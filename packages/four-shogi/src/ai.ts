import { createAnalysisCacheKey, type AnalysisPosition } from "./analysis";
import { readReplayEvent } from "./analysisInput";
import { evaluateAiPosition } from "./aiEvaluation";
import { checkedSides, createAiSearch } from "./aiSearch";
import {
  aiVersions,
  type AiOptions,
  type AiSearchSettings,
  type AiControl,
  type AiProgress,
  type AiResult,
  type AiStopReason,
} from "./aiTypes";

export { aiVersions } from "./aiTypes";
export type {
  AiOptions,
  AiSearchSettings,
  AiControl,
  AiProgress,
  AiResult,
  AiStopReason,
  AiCandidate,
  AiEvaluation,
  AiValue,
  AiLineStep,
} from "./aiTypes";

function snapshot<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(object: unknown) {
    if (object !== null && typeof object === "object") {
      for (const child of Object.values(object)) freeze(child);
      Object.freeze(object);
    }
  }
  freeze(copy);
  return copy;
}
function resolveOptions(options: AiOptions): { codeVersion: string; settings: AiSearchSettings } {
  const allowed = new Set([
    "codeVersion",
    "modelId",
    "timeBudgetMs",
    "maxWork",
    "maxDepth",
    "width",
    "rootWidth",
    "extensions",
    "candidateCount",
    "includeAction",
  ]);
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !allowed.has(key)) ||
    typeof options.codeVersion !== "string" ||
    options.codeVersion.trim().length === 0
  )
    throw new TypeError("コード版と既知の探索条件が必要です");
  if (options.modelId !== undefined && options.modelId !== null)
    throw new TypeError("この版は静的評価のみで、モデルIDを使用できません");
  const settings: AiSearchSettings = {
    timeBudgetMs: options.timeBudgetMs ?? null,
    maxWork: options.maxWork ?? 2048,
    maxDepth: options.maxDepth ?? 64,
    width: options.width ?? 6,
    rootWidth: options.rootWidth ?? 24,
    extensions: options.extensions ?? 2,
    candidateCount: options.candidateCount ?? 3,
    includeAction:
      options.includeAction == null
        ? null
        : (() => {
            const event = readReplayEvent({
              type: "action",
              side: "south",
              action: options.includeAction,
            });
            if (event.type !== "action") throw new TypeError("比較手が必要です");
            return event.action;
          })(),
  };
  if (
    [settings.maxWork, settings.maxDepth, settings.width, settings.rootWidth].some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    ) ||
    settings.maxDepth > 256
  )
    throw new TypeError("探索量・幅は正の整数、深さは1〜256で指定してください");
  if (
    !Number.isSafeInteger(settings.extensions) ||
    settings.extensions < 0 ||
    settings.extensions > 4 ||
    !Number.isSafeInteger(settings.candidateCount) ||
    settings.candidateCount < 2 ||
    settings.candidateCount > 5 ||
    settings.rootWidth < settings.candidateCount
  )
    throw new TypeError("延長は0〜4、候補数は2〜5、根の幅は候補数以上にしてください");
  if (
    settings.timeBudgetMs !== null &&
    (!Number.isFinite(settings.timeBudgetMs) || settings.timeBudgetMs < 0)
  )
    throw new TypeError("時間予算は非負の有限ミリ秒です");
  return { codeVersion: options.codeVersion, settings: snapshot(settings) };
}

/** CPU・解析・教師生成で同じ探索を使い、完成した反復だけを比較結果へ公開します。 */
export async function analyzePosition(
  position: AnalysisPosition,
  options: AiOptions,
  control: AiControl = {},
): Promise<AiResult> {
  const { codeVersion, settings } = resolveOptions(options);
  const readTime = control.now ?? (() => performance.now());
  let lastTime = -Infinity;
  function now() {
    const value = readTime();
    if (!Number.isFinite(value) || value < lastTime)
      throw new TypeError("時計は単調な有限ミリ秒を返してください");
    lastTime = value;
    return value;
  }
  const started = now();
  // hash計算・合法手の確保も同じ時間予算に含め、解決済み設定を識別します。
  const cacheKey = await createAnalysisCacheKey(position, {
    codeVersion,
    analysisVersion: aiVersions.analysisVersion,
    modelId: null,
    parameters: { ...aiVersions, ...settings },
  });
  const preparationStarted = now();
  const session = createAiSearch(position.state, settings);
  const preparationMs = now() - preparationStarted;
  const staticEvaluation = evaluateAiPosition(position.state);
  session.stats.evaluations++;
  const yieldToHost =
    control.yieldToHost ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  let yields = 0;
  let lastYieldWork = 0;
  let lastYieldTime = lastTime;
  let notifiedDepth = -1;
  let reason: AiStopReason | null = null;
  function progress(): AiProgress {
    return snapshot({
      ...session.stats,
      elapsedMs: now() - started,
      candidates: session.results().candidates,
    });
  }
  function interrupted(): AiStopReason | null {
    const elapsed = now() - started;
    if (control.signal?.aborted || control.isCancelled?.()) return "cancelled";
    if (settings.timeBudgetMs !== null && elapsed >= settings.timeBudgetMs) return "deadline";
    return null;
  }
  if (position.state.status === "playing" && session.stats.generatedMoves > 0) {
    for (let step = session.steps.next(); !step.done; step = session.steps.next()) {
      reason = interrupted();
      if (reason !== null) break;
      if (session.stats.work + step.value > settings.maxWork) {
        reason = "work_limit";
        break;
      }
      if (session.stats.completedDepth !== notifiedDepth) {
        notifiedDepth = session.stats.completedDepth;
        control.onProgress?.(progress());
        reason = interrupted();
        if (reason !== null) break;
      }
      if (session.stats.work - lastYieldWork >= 128 || lastTime - lastYieldTime >= 8) {
        control.onProgress?.(progress());
        await yieldToHost();
        yields++;
        lastYieldWork = session.stats.work;
        lastYieldTime = now();
        reason = interrupted();
        if (reason !== null) break;
      }
    }
  }
  session.steps.return();
  reason ??= session.doneReason;
  const cutoff = reason === "work_limit" || reason === "deadline" || reason === "cancelled";
  const { candidates, comparedAction } = session.results(cutoff);
  const currentDanger = {
    checkedSides: checkedSides(position.state),
    eliminations: position.state.eliminations,
  };
  control.onProgress?.(snapshot({ ...session.stats, elapsedMs: now() - started, candidates }));
  const elapsedMs = now() - started;
  const result: AiResult = {
    schemaVersion: 1,
    status:
      reason === "terminal" || reason === "no_legal_actions"
        ? reason
        : reason === "cancelled"
          ? "cancelled"
          : cutoff
            ? "limited"
            : "completed",
    input: {
      stateHash: position.stateHash,
      eventOffset: position.eventOffset,
      ruleProfileId: position.ruleProfileId,
      rulesVersion: position.rulesVersion,
      threePlayerAttackProhibited: position.state.threePlayerAttackProhibited,
      rootSide: position.state.turn,
    },
    cacheKey,
    versions: { ...aiVersions, codeVersion },
    settings,
    model: { requestedModelId: null, loadedModelId: null, usedModelId: null, inferenceCount: 0 },
    recommendedAction: candidates[0]?.action ?? null,
    staticEvaluation,
    evaluation: reason === "terminal" ? staticEvaluation : (candidates[0]?.evaluation ?? null),
    currentDanger,
    candidates,
    comparedAction,
    diagnostics: {
      ...session.stats,
      elapsedMs,
      stopReason: reason,
      fallbackReason:
        session.stats.completedDepth === 0 && candidates.length > 0
          ? "no_completed_iteration"
          : null,
      legalPreparationMs: preparationMs,
      deadlineOverrunMs:
        settings.timeBudgetMs === null ? 0 : Math.max(0, elapsedMs - settings.timeBudgetMs),
      yields,
      algorithm: "maxn",
    },
  };
  return snapshot(result);
}
