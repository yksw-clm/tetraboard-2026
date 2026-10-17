import { createAnalysisCacheKey, type AnalysisPosition } from "./analysis";
import { readReplayEvent } from "./analysisInput";
import { checkedSides, createAiSearch } from "./aiSearch";
import { createAiMcts } from "./aiMcts";
import { createAiClock, runAiSession } from "./aiBudget";
import { defaultEvaluationWeights } from "./cpuEvaluation";
import { createAiContext } from "./aiSearchContext";
import { AiModelFailure, createModelDriver } from "./aiModel";
import { featureVersion } from "./modelFeatureEncoding";
import {
  aiVersions,
  type AiOptions,
  type AiSearchSettings,
  type AiControl,
  type AiResult,
  type AiSearchStats,
} from "./aiTypes";

export { aiVersions } from "./aiTypes";
export type { AiModelEvaluator, AiModelInput, AiModelOutput } from "./aiModel";
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
export function resolveAiOptions(options: AiOptions): {
  codeVersion: string;
  settings: AiSearchSettings;
  versions: typeof aiVersions & { codeVersion: string };
} {
  const allowed = new Set([
    "codeVersion",
    "modelId",
    "modelTimeoutMs",
    "timeBudgetMs",
    "maxWork",
    "maxDepth",
    "width",
    "rootWidth",
    "extensions",
    "candidateCount",
    "includeAction",
    "algorithm",
    "cacheSize",
    "moveOrdering",
    "evaluationWeights",
    "exploration",
    "rolloutPlies",
    "maxSimulations",
    "seed",
    "dangerWork",
    "dangerPlies",
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
  const requested = options.modelId ?? null;
  if (
    requested !== null &&
    (!/^four-shogi-tiny-policy-value-v1:[0-9a-f]{64}$/.test(requested) ||
      (options.algorithm ?? "maxn") !== "maxn")
  )
    throw new TypeError("登録されたモデルIDとMaxⁿを指定してください");
  if (
    options.modelTimeoutMs !== undefined &&
    (!requested ||
      !Number.isSafeInteger(options.modelTimeoutMs) ||
      options.modelTimeoutMs < 1 ||
      options.modelTimeoutMs > 60000)
  )
    throw new TypeError("モデル推論期限はモデル指定時に1〜60000msです");
  if (
    options.evaluationWeights !== undefined &&
    (!options.evaluationWeights ||
      typeof options.evaluationWeights !== "object" ||
      Array.isArray(options.evaluationWeights) ||
      Object.keys(options.evaluationWeights).some(
        (key) => !Object.hasOwn(defaultEvaluationWeights, key),
      ))
  )
    throw new TypeError("評価係数は既知の非負の有限数で指定してください");
  const settings: AiSearchSettings = {
    ...(requested ? { modelTimeoutMs: options.modelTimeoutMs ?? 1000 } : {}),
    timeBudgetMs: options.timeBudgetMs ?? null,
    maxWork: options.maxWork ?? 2048,
    maxDepth: options.maxDepth ?? 64,
    width: options.width ?? 6,
    rootWidth: options.rootWidth ?? 24,
    extensions: options.extensions ?? 1,
    candidateCount: options.candidateCount ?? 3,
    algorithm: options.algorithm ?? "maxn",
    cacheSize: options.cacheSize ?? 256,
    moveOrdering: options.moveOrdering ?? "tactical",
    evaluationWeights: { ...defaultEvaluationWeights, survival: 0, ...options.evaluationWeights },
    exploration: options.exploration ?? 1.4,
    rolloutPlies: options.rolloutPlies ?? 2,
    maxSimulations: options.maxSimulations ?? 10000,
    seed: options.seed ?? 0,
    dangerWork: options.dangerWork ?? 0,
    dangerPlies: options.dangerPlies ?? 8,
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
  if (
    !["maxn", "mcts"].includes(settings.algorithm) ||
    !["tactical", "previous"].includes(settings.moveOrdering)
  )
    throw new TypeError("未知の探索方式・手順序です");
  if (
    Object.values(settings.evaluationWeights).some(
      (value) => !Number.isFinite(value) || value < 0,
    ) ||
    settings.evaluationWeights.survival !== 0
  )
    throw new TypeError("評価係数は非負の有限数で、生存人数の加点は0にしてください");
  for (const [value, minimum, maximum] of [
    [settings.cacheSize, 0, 2048],
    [settings.rolloutPlies, 0, 32],
    [settings.maxSimulations, 1, 1000000],
    [settings.seed, 0, 0xffffffff],
    [settings.dangerWork, 0, settings.maxWork],
    [settings.dangerPlies, 1, 16],
  ])
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new TypeError("実験の探索条件が範囲外です");
  if (!Number.isFinite(settings.exploration) || settings.exploration < 0)
    throw new TypeError("探索係数は非負の有限数です");
  return {
    codeVersion: options.codeVersion,
    settings: snapshot(settings),
    versions: snapshot({
      ...aiVersions,
      codeVersion: options.codeVersion,
      searchVersion:
        settings.algorithm === "maxn" ? aiVersions.searchVersion : "vector-uct-experiment-v1",
      opponentModelId:
        settings.algorithm === "maxn" ? aiVersions.opponentModelId : "selfish-uct-v1",
      seed: settings.algorithm === "mcts" ? settings.seed : null,
      ...(requested
        ? {
            analysisVersion: "singles-analysis-model-v1",
            searchVersion: "selective-maxn-policy-value-v1",
            evaluationVersion: "uncalibrated-sole-first-model-v1",
            featureVersion,
            actionVersion: "four-shogi-policy-index-v1",
          }
        : {}),
    }),
  };
}

/** CPU・解析・教師生成で同じ探索を使い、完成した反復だけを比較結果へ公開します。 */
export async function analyzePosition(
  position: AnalysisPosition,
  options: AiOptions,
  control: AiControl = {},
): Promise<AiResult> {
  const { codeVersion, settings, versions: requestedVersions } = resolveAiOptions(options);
  let versions = requestedVersions;
  const now = createAiClock(control.now);
  const started = now();
  const requestedModelId = options.modelId ?? null;
  const loadedModelId = control.modelEvaluator?.modelId ?? null;
  let modelFailure: AiModelFailure | null =
    requestedModelId === null
      ? null
      : !control.modelEvaluator
        ? new AiModelFailure(
            control.modelLoadError ? "model_load_failed" : "missing_model",
            control.modelLoadError ?? "モデル評価器がありません",
          )
        : loadedModelId !== requestedModelId
          ? new AiModelFailure("model_mismatch", "要求とロード済みモデルが不一致です")
          : null;
  const driver =
    requestedModelId && !modelFailure
      ? createModelDriver(control.modelEvaluator!, settings.modelTimeoutMs!, now)
      : undefined;
  // hash計算・合法手の確保も同じ時間予算に含め、解決済み設定を識別します。
  let cacheKey = await createAnalysisCacheKey(position, {
    codeVersion,
    analysisVersion: versions.analysisVersion,
    modelId: requestedModelId,
    parameters: { ...versions, ...settings },
  });
  const preparationStarted = now();
  let session =
    settings.algorithm === "maxn"
      ? createAiSearch(position.state, settings, createAiContext(position.state, settings, driver))
      : createAiMcts(position.state, settings);
  let preparationMs = now() - preparationStarted;
  const staticEvaluation = session.staticEvaluation;
  let discarded: AiSearchStats | null = null;
  const sumStats = (current: AiSearchStats): AiSearchStats =>
    discarded
      ? (Object.fromEntries(
          Object.entries(current).map(([key, value]) => [
            key,
            key === "completedDepth"
              ? value
              : key === "maxVisitedPly"
                ? Math.max(value, discarded![key])
                : value + discarded![key as keyof AiSearchStats],
          ]),
        ) as AiSearchStats)
      : current;
  const notify = control.onProgress
    ? (progress: Parameters<NonNullable<AiControl["onProgress"]>>[0]) =>
        control.onProgress!(snapshot({ ...progress, ...sumStats(progress) }))
    : undefined;
  let execution;
  try {
    execution = await runAiSession(session, settings, control, started, now, notify);
  } catch (error) {
    if (!(error instanceof AiModelFailure)) throw error;
    modelFailure = error;
    discarded = { ...session.stats };
    const remaining = { ...settings, maxWork: Math.max(0, settings.maxWork - discarded.work) };
    const restarted = now();
    session = createAiSearch(position.state, remaining);
    preparationMs += now() - restarted;
    execution = await runAiSession(session, remaining, control, started, now, notify);
  }
  if (modelFailure) {
    versions = resolveAiOptions({ ...options, modelId: null, modelTimeoutMs: undefined }).versions;
    cacheKey = await createAnalysisCacheKey(position, {
      codeVersion,
      analysisVersion: versions.analysisVersion,
      modelId: null,
      parameters: {
        ...versions,
        ...settings,
        requestedModelId,
        modelFallbackReason: modelFailure.reason,
      },
    });
  }
  const { reason, cutoff, yields, candidates, comparedAction } = execution;
  const stats = sumStats(session.stats);
  const currentDanger = {
    checkedSides: checkedSides(position.state),
    eliminations: position.state.eliminations,
  };
  control.onProgress?.(snapshot({ ...stats, elapsedMs: now() - started, candidates }));
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
    versions,
    settings,
    model:
      requestedModelId === null
        ? { requestedModelId: null, loadedModelId, usedModelId: null, inferenceCount: 0 }
        : {
            requestedModelId,
            loadedModelId,
            usedModelId:
              !modelFailure &&
              session.stats.completedDepth > 0 &&
              (driver?.stats.policyUses || driver?.stats.valueUses)
                ? requestedModelId
                : null,
            inferenceCount:
              modelFailure || session.stats.completedDepth === 0
                ? 0
                : (driver?.stats.inferenceCount ?? 0),
            attemptedInferenceCount: driver?.stats.inferenceCount ?? 0,
            inferenceCalls: driver?.stats.inferenceCalls ?? 0,
            policyUses:
              modelFailure || session.stats.completedDepth === 0
                ? 0
                : (driver?.stats.policyUses ?? 0),
            valueUses:
              modelFailure || session.stats.completedDepth === 0
                ? 0
                : (driver?.stats.valueUses ?? 0),
            inferenceMs: driver?.stats.inferenceMs ?? 0,
            discardedWork: discarded?.work ?? 0,
            fallbackReason: modelFailure?.reason ?? null,
            fallbackDetail: modelFailure?.message ?? null,
          },
    recommendedAction: candidates[0]?.action ?? null,
    staticEvaluation,
    evaluation: reason === "terminal" ? staticEvaluation : (candidates[0]?.evaluation ?? null),
    currentDanger,
    candidates,
    comparedAction,
    diagnostics: {
      ...stats,
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
      algorithm: settings.algorithm,
    },
  };
  return snapshot(result);
}
