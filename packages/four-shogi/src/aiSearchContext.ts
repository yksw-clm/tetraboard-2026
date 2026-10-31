import { getCheckState } from "./board";
import { priority } from "./cpuSearch";
import { evaluateAiPosition } from "./aiEvaluation";
import { getLegalMoves, applyLegalMove } from "./transition";
import { getActiveSides, type FourShogiState, type Side } from "./types";
import type { OrdinaryMove } from "./moves";
import { encodeAction } from "./actionEncoding";
import { encodeStateFeatures } from "./modelFeatureEncoding";
import {
  AiModelFailure,
  modelEvaluation,
  validateModelOutputs,
  type AiSyncModel,
  type AiModelDriver,
  type AiModelOutput,
} from "./aiModel";
import type {
  AiCandidate,
  AiEvaluation,
  AiLineStep,
  AiSearchSettings,
  AiSearchStats,
} from "./aiTypes";

export type AiBranch = { evaluation: AiEvaluation; line: AiLineStep[]; selective: boolean };
export type AiAdvance = { state: FourShogiState; step: AiLineStep };
/** 検討用の明示指定にだけ適用し、公開CPUと共通AIの評価を維持します。 */
export type AiContextProfile = {
  model?: AiSyncModel;
  modelUsage?: "policy-value" | "policy" | "value";
  evaluate: (state: FourShogiState) => AiEvaluation;
  orderingBonus?: (
    state: FourShogiState,
    move: OrdinaryMove,
    checks?: typeof getCheckState,
  ) => number;
  replaceCache?: boolean;
  preservePromotions?: boolean;
  measure?: boolean;
  cacheLeafEvaluations?: boolean;
  allMoves?: boolean;
  measureDetails?: boolean;
  sharedChecks?: boolean;
};
export type AiContextMetrics = {
  modelInferences?: number;
  modelPolicyUses?: number;
  modelValueUses?: number;
  modelInferenceMs?: number;
  legalMs: number;
  transitionMs: number;
  evaluationMs: number;
  orderingMs: number;
  cacheEvictions: number;
  initialLegalMs?: number;
  initialEvaluationMs?: number;
  priorityMs?: number;
  priorityCalls?: number;
  orderingBonusMs?: number;
  legalCalls?: number;
  checkCalls?: number;
  checkMs?: number;
  checkCacheHits?: number;
};
type CachedNode = {
  moves?: OrdinaryMove[];
  evaluation?: AiEvaluation;
  prediction?: AiModelOutput;
  transitions: Map<OrdinaryMove, AiAdvance>;
  bestAction?: string;
  ordered?: { move: OrdinaryMove; index: number; score: number }[];
};
export function checkedSides(state: FourShogiState, readChecks = getCheckState): Side[] {
  const checks = readChecks(state);
  return getActiveSides(state).filter((side) => checks[side]);
}
export function makeAiDanger(line: readonly AiLineStep[], root: Side): AiCandidate["danger"] {
  let boundary: AiCandidate["danger"]["untilNextOwnTurn"] = "horizon";
  let end = line.length;
  for (const [index, step] of line.entries()) {
    if (step.eliminations.some((entry) => entry.side === root)) boundary = "eliminated";
    else if (step.result) boundary = "terminal";
    else if (step.nextTurn === root) boundary = "returned";
    if (boundary !== "horizon") {
      end = index + 1;
      break;
    }
  }
  return {
    kind: "pv_example",
    forced: false,
    untilNextOwnTurn: boundary,
    evidence: line.slice(0, end),
    alternatives: null,
  };
}
export function makeAiCandidate(
  action: AiCandidate["action"],
  branch: AiBranch,
  root: Side,
  depth: number,
  nodes: number,
  work: number,
): AiCandidate {
  return {
    action,
    evaluation: branch.evaluation,
    lineEvaluation: branch.evaluation,
    comparisonKind: "uniform_depth",
    visits: 0,
    completedDepth: depth,
    iterationNodes: nodes,
    iterationWork: work,
    selective: branch.selective,
    cutoff: false,
    line: branch.line,
    danger: makeAiDanger(branch.line, root),
  };
}

/** 同じ実行・同じ枝状態の参照だけを再利用し、履歴を省いた局面キーで混同しません。 */
export function createAiContext(
  input: FourShogiState,
  settings: AiSearchSettings,
  model?: AiModelDriver,
  profile?: AiContextProfile,
) {
  if (input.mode !== "singles") throw new TypeError("新AIはシングルス専用です");
  const stats: AiSearchStats = {
    work: 0,
    nodes: 0,
    generatedMoves: 0,
    evaluations: 1,
    completedDepth: 0,
    extendedNodes: 0,
    cacheEntries: 0,
    legalCacheHits: 0,
    transitionCacheHits: 0,
    evaluationCacheHits: 0,
    orderingCacheHits: 0,
    simulations: 0,
    maxVisitedPly: 0,
  };
  const start: FourShogiState = { ...input, repetitions: {} };
  const lookup = (key: string) => input.repetitions[key] ?? 0;
  const cache = new WeakMap<FourShogiState, CachedNode>();
  let cacheLimit = settings.cacheSize;
  // 純粋遷移で作った探索内の状態参照だけを使い、盤面だけの同一視を避けます。
  const checkCache = profile?.sharedChecks
    ? new WeakMap<FourShogiState, ReturnType<typeof getCheckState>>()
    : null;
  const leafEvaluations = new WeakMap<FourShogiState, AiEvaluation>();
  const retained = new Map<FourShogiState, true>();
  const metrics: AiContextMetrics = {
    legalMs: 0,
    transitionMs: 0,
    evaluationMs: 0,
    orderingMs: 0,
    cacheEvictions: 0,
  };
  const clock = () => (profile?.measure ? performance.now() : 0);
  const detailClock = () => (profile?.measureDetails ? performance.now() : 0);
  function checks(state: FourShogiState) {
    const started = detailClock();
    let value = checkCache?.get(state);
    if (value) {
      if (profile?.measureDetails) metrics.checkCacheHits = (metrics.checkCacheHits ?? 0) + 1;
    } else {
      value = getCheckState(state);
      if (checkCache) {
        Object.freeze(value);
        checkCache.set(state, value);
      }
      if (profile?.measureDetails) metrics.checkCalls = (metrics.checkCalls ?? 0) + 1;
    }
    if (profile?.measureDetails) {
      metrics.checkMs = (metrics.checkMs ?? 0) + detailClock() - started;
    }
    return value;
  }
  function node(state: FourShogiState) {
    const existing = cache.get(state);
    if (existing) return existing;
    if (cacheLimit === 0) return undefined;
    if (stats.cacheEntries >= cacheLimit) {
      if (!profile?.replaceCache) return undefined;
      const oldest = retained.keys().next().value!;
      retained.delete(oldest);
      cache.delete(oldest);
      stats.cacheEntries--;
      metrics.cacheEvictions++;
    }
    const created: CachedNode = { transitions: new Map() };
    cache.set(state, created);
    if (profile?.replaceCache) retained.set(state, true);
    stats.cacheEntries++;
    return created;
  }
  const started = clock();
  const legal = getLegalMoves(start);
  metrics.legalCalls = 1;
  metrics.legalMs += clock() - started;
  metrics.initialLegalMs = clock() - started;
  stats.generatedMoves = legal.length;
  const initialNode = node(start);
  if (initialNode) initialNode.moves = legal;
  const evaluationStarted = clock();
  const staticEvaluation =
    profile?.evaluate(input) ?? evaluateAiPosition(input, settings.evaluationWeights);
  metrics.initialEvaluationMs = clock() - evaluationStarted;
  const includeIndex =
    settings.includeAction === null
      ? -1
      : legal.findIndex(
          (move) => JSON.stringify(move.action) === JSON.stringify(settings.includeAction),
        );
  if (settings.includeAction !== null && includeIndex < 0)
    throw new TypeError("比較指定手は元局面の合法手である必要があります");
  /** 既存の状態参照を解放し、着手処理を行わずに保持枠だけを縮小します。 */
  function limitCache(limit: number) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > cacheLimit ||
      (!profile?.replaceCache && limit !== settings.cacheSize)
    )
      throw new TypeError("探索キャッシュの縮小上限が不正です");
    cacheLimit = limit;
    while (stats.cacheEntries > limit) {
      const oldest = retained.keys().next().value!;
      retained.delete(oldest);
      cache.delete(oldest);
      stats.cacheEntries--;
      metrics.cacheEvictions++;
    }
  }
  function* spend(cost = 1): Generator<number, void> {
    yield cost;
    stats.work += cost;
  }
  function* moves(state: FourShogiState): Generator<number, OrdinaryMove[]> {
    yield* spend();
    const record = node(state);
    if (record?.moves) {
      stats.legalCacheHits++;
      return record.moves;
    }
    const started = clock();
    const result = getLegalMoves(state);
    metrics.legalCalls = (metrics.legalCalls ?? 0) + 1;
    metrics.legalMs += clock() - started;
    stats.generatedMoves += result.length;
    yield* spend(Math.ceil(result.length / 16));
    if (record) record.moves = result;
    return result;
  }
  function* evaluate(state: FourShogiState): Generator<number, AiEvaluation> {
    yield* spend();
    // 一度しか訪れない葉で、繰り返し使う内部節点を追い出さないようにします。
    const record = profile?.cacheLeafEvaluations === false ? cache.get(state) : node(state);
    const cached =
      record?.evaluation ??
      (profile?.cacheLeafEvaluations === false ? leafEvaluations.get(state) : undefined);
    if (cached) {
      stats.evaluationCacheHits++;
      return cached;
    }
    const prediction =
      (model || (profile?.model && profile.modelUsage !== "policy")) && state.status === "playing"
        ? yield* predict(state)
        : null;
    const started = clock();
    const value = prediction
      ? modelEvaluation(state, prediction)
      : (profile?.evaluate(state) ?? evaluateAiPosition(state, settings.evaluationWeights));
    metrics.evaluationMs += clock() - started;
    if (prediction) {
      if (model) model.stats.valueUses++;
      else metrics.modelValueUses = (metrics.modelValueUses ?? 0) + 1;
    }
    stats.evaluations++;
    if (record) record.evaluation = value;
    if (profile?.cacheLeafEvaluations === false) leafEvaluations.set(state, value);
    return value;
  }
  function modelInput(state: FourShogiState, legalMoves: OrdinaryMove[], id: string) {
    try {
      return {
        id,
        restricted: state.threePlayerAttackProhibited,
        features: encodeStateFeatures({
          ...state,
          repetitions: { ...input.repetitions, ...state.repetitions },
        }),
        legalActionIds: legalMoves.map((move) => encodeAction(move.action)).sort((a, b) => a - b),
      };
    } catch (error) {
      throw new AiModelFailure("model_features", String(error));
    }
  }
  function* predict(
    state: FourShogiState,
    legalMoves?: OrdinaryMove[],
  ): Generator<number, AiModelOutput> {
    const record = node(state);
    if (record?.prediction) return record.prediction;
    const available = legalMoves ?? (yield* moves(state));
    yield* spend();
    const request = modelInput(state, available, "0");
    let prediction: AiModelOutput;
    if (profile?.model) {
      const started = performance.now();
      prediction = profile.model.predict(request);
      validateModelOutputs([request], [prediction]);
      metrics.modelInferences = (metrics.modelInferences ?? 0) + 1;
      metrics.modelInferenceMs = (metrics.modelInferenceMs ?? 0) + performance.now() - started;
    } else [prediction] = yield* model!.request([request]);
    if (record) record.prediction = prediction;
    return prediction;
  }
  function* prefetch(states: FourShogiState[]): Generator<number, void> {
    if (!model) return;
    const pending = states.filter(
      (state) => state.status === "playing" && node(state) && !node(state)?.prediction,
    );
    const batch: { state: FourShogiState; input: ReturnType<typeof modelInput> }[] = [];
    let histories = 0;
    function* flush(): Generator<number, void> {
      if (!batch.length) return;
      const outputs = yield* model!.request(batch.map((entry) => entry.input));
      batch.forEach((entry, index) => {
        node(entry.state)!.prediction = outputs[index];
      });
      batch.length = 0;
      histories = 0;
    }
    for (const state of pending) {
      const available = yield* moves(state);
      yield* spend();
      const next = modelInput(state, available, String(batch.length));
      if (batch.length >= 16 || histories + next.features.history.length > 4096) yield* flush();
      next.id = String(batch.length);
      histories += next.features.history.length;
      batch.push({ state, input: next });
    }
    yield* flush();
  }
  function* rootOrder(): Generator<number, { move: OrdinaryMove; index: number }[]> {
    if (!model && (!profile?.model || profile.modelUsage === "value"))
      return legal.map((move, index) => ({ move, index }));
    const prediction = yield* predict(start, legal);
    if (model) model.stats.policyUses++;
    else metrics.modelPolicyUses = (metrics.modelPolicyUses ?? 0) + 1;
    return sortWithPolicy(
      legal.map((move, index) => ({ move, index, score: priority(move, start.turn!) })),
      prediction,
    );
  }
  function sortWithPolicy(
    entries: { move: OrdinaryMove; index: number; score: number }[],
    prediction: AiModelOutput,
  ) {
    const policy = new Map(
      prediction.legalActionIds.map((id, index) => [id, prediction.policy[index]]),
    );
    const forcing = (entry: (typeof entries)[number]) =>
      Number(entry.score >= 10000 || entry.move.captured !== null);
    return entries.sort(
      (a, b) =>
        forcing(b) - forcing(a) ||
        policy.get(encodeAction(b.move.action))! - policy.get(encodeAction(a.move.action))! ||
        b.score - a.score ||
        a.index - b.index,
    );
  }
  function* advance(
    state: FourShogiState,
    move: OrdinaryMove,
    ply: number,
  ): Generator<number, AiAdvance> {
    yield* spend();
    stats.nodes++;
    const record = node(state);
    const cached = record?.transitions.get(move);
    if (cached) {
      stats.transitionCacheHits++;
      return { state: cached.state, step: { ...cached.step, afterPly: ply + 1 } };
    }
    const started = clock();
    const transition = applyLegalMove(state, state.turn!, move, lookup);
    metrics.transitionMs += clock() - started;
    const next = transition.state;
    const result = {
      state: next,
      step: {
        side: state.turn!,
        action: move.action,
        afterPly: ply + 1,
        nextTurn: next.turn,
        checkedSides: checkedSides(next, checks),
        captured: transition.captured,
        eliminations: transition.eliminations,
        result: next.result,
      },
    };
    if (record) record.transitions.set(move, result);
    return result;
  }
  function* ordered(
    state: FourShogiState,
    legalMoves: OrdinaryMove[],
  ): Generator<number, { move: OrdinaryMove; index: number; score: number }[]> {
    const record = node(state);
    let selected = record?.ordered;
    if (selected) stats.orderingCacheHits++;
    else {
      const started = clock();
      const checked = checks(state)[state.turn!];
      const entries = legalMoves.map((move, index) => {
        const started = detailClock();
        const score = priority(move, state.turn!, checks(move.state));
        const bonusStarted = detailClock();
        const bonus = profile?.orderingBonus?.(state, move, checks) ?? 0;
        if (profile?.measureDetails) {
          metrics.priorityMs = (metrics.priorityMs ?? 0) + bonusStarted - started;
          metrics.orderingBonusMs = (metrics.orderingBonusMs ?? 0) + detailClock() - bonusStarted;
          metrics.priorityCalls = (metrics.priorityCalls ?? 0) + 1;
        }
        return { move, index, score: score + bonus };
      });
      if (model || (profile?.model && profile.modelUsage !== "value")) {
        const prediction = yield* predict(state, legalMoves);
        if (model) model.stats.policyUses++;
        else metrics.modelPolicyUses = (metrics.modelPolicyUses ?? 0) + 1;
        selected = sortWithPolicy(entries, prediction);
      } else selected = entries.sort((a, b) => b.score - a.score || a.index - b.index);
      selected = selected.filter(
        (entry, index) =>
          profile?.allMoves ||
          index < settings.width ||
          checked ||
          entry.score >= 10000 ||
          entry.move.captured !== null ||
          (profile?.preservePromotions &&
            entry.move.action.type === "movePiece" &&
            entry.move.action.promote),
      );
      metrics.orderingMs += clock() - started;
      if (record) record.ordered = selected;
    }
    const preferred =
      settings.moveOrdering === "previous" ? cache.get(state)?.bestAction : undefined;
    if (preferred)
      selected = [...selected].sort(
        (a, b) =>
          Number(JSON.stringify(b.move.action) === preferred) -
            Number(JSON.stringify(a.move.action) === preferred) ||
          b.score - a.score ||
          a.index - b.index,
      );
    return selected;
  }
  function remember(state: FourShogiState, action: AiCandidate["action"]) {
    const record = node(state);
    if (record) record.bestAction = JSON.stringify(action);
  }
  function fallback(): AiCandidate[] {
    return input.turn === null || legal.length === 0
      ? []
      : [
          {
            action: legal[0].action,
            evaluation: null,
            lineEvaluation: null,
            comparisonKind: settings.algorithm === "maxn" ? "uniform_depth" : "sample_mean",
            visits: 0,
            completedDepth: 0,
            iterationNodes: 0,
            iterationWork: 0,
            selective: true,
            cutoff: true,
            line: [],
            danger: makeAiDanger([], input.turn),
          },
        ];
  }
  return {
    input,
    settings,
    limitCache,
    get cacheLimit() {
      return cacheLimit;
    },
    stats,
    metrics,
    start,
    root: input.turn,
    legal,
    includeIndex,
    staticEvaluation,
    spend,
    moves,
    evaluate,
    advance,
    ordered,
    remember,
    fallback,
    model,
    prefetch,
    rootOrder,
    checks,
  };
}
export type AiContext = ReturnType<typeof createAiContext>;
