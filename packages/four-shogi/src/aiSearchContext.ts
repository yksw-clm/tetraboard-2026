import { getCheckState } from "./board";
import { priority } from "./cpuSearch";
import { evaluateAiPosition } from "./aiEvaluation";
import { getLegalMoves, applyLegalMove } from "./transition";
import { getActiveSides, type FourShogiState, type Side } from "./types";
import type { OrdinaryMove } from "./moves";
import { encodeAction } from "./actionEncoding";
import { encodeStateFeatures } from "./modelFeatureEncoding";
import { AiModelFailure, modelEvaluation, type AiModelDriver, type AiModelOutput } from "./aiModel";
import type {
  AiCandidate,
  AiEvaluation,
  AiLineStep,
  AiSearchSettings,
  AiSearchStats,
} from "./aiTypes";

export type AiBranch = { evaluation: AiEvaluation; line: AiLineStep[]; selective: boolean };
export type AiAdvance = { state: FourShogiState; step: AiLineStep };
type CachedNode = {
  moves?: OrdinaryMove[];
  evaluation?: AiEvaluation;
  prediction?: AiModelOutput;
  transitions: Map<OrdinaryMove, AiAdvance>;
  bestAction?: string;
  ordered?: { move: OrdinaryMove; index: number; score: number }[];
};
export function checkedSides(state: FourShogiState): Side[] {
  const checks = getCheckState(state);
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
  function node(state: FourShogiState) {
    const existing = cache.get(state);
    if (existing) return existing;
    if (stats.cacheEntries >= settings.cacheSize) return undefined;
    const created: CachedNode = { transitions: new Map() };
    cache.set(state, created);
    stats.cacheEntries++;
    return created;
  }
  const legal = getLegalMoves(start);
  stats.generatedMoves = legal.length;
  const initialNode = node(start);
  if (initialNode) initialNode.moves = legal;
  const staticEvaluation = evaluateAiPosition(input, settings.evaluationWeights);
  const includeIndex =
    settings.includeAction === null
      ? -1
      : legal.findIndex(
          (move) => JSON.stringify(move.action) === JSON.stringify(settings.includeAction),
        );
  if (settings.includeAction !== null && includeIndex < 0)
    throw new TypeError("比較指定手は元局面の合法手である必要があります");
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
    const result = getLegalMoves(state);
    stats.generatedMoves += result.length;
    yield* spend(Math.ceil(result.length / 16));
    if (record) record.moves = result;
    return result;
  }
  function* evaluate(state: FourShogiState): Generator<number, AiEvaluation> {
    yield* spend();
    const record = node(state);
    if (record?.evaluation) {
      stats.evaluationCacheHits++;
      return record.evaluation;
    }
    const prediction = model && state.status === "playing" ? yield* predict(state) : null;
    const value = prediction
      ? modelEvaluation(state, prediction)
      : evaluateAiPosition(state, settings.evaluationWeights);
    if (prediction) model!.stats.valueUses++;
    stats.evaluations++;
    if (record) record.evaluation = value;
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
    const [prediction] = yield* model!.request([modelInput(state, available, "0")]);
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
    if (!model) return legal.map((move, index) => ({ move, index }));
    const prediction = yield* predict(start, legal);
    model.stats.policyUses++;
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
    const transition = applyLegalMove(state, state.turn!, move, lookup);
    const next = transition.state;
    const result = {
      state: next,
      step: {
        side: state.turn!,
        action: move.action,
        afterPly: ply + 1,
        nextTurn: next.turn,
        checkedSides: checkedSides(next),
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
      const checked = getCheckState(state)[state.turn!];
      const entries = legalMoves.map((move, index) => ({
        move,
        index,
        score: priority(move, state.turn!),
      }));
      if (model) {
        const prediction = yield* predict(state, legalMoves);
        model.stats.policyUses++;
        selected = sortWithPolicy(entries, prediction);
      } else selected = entries.sort((a, b) => b.score - a.score || a.index - b.index);
      selected = selected.filter(
        (entry, index) =>
          index < settings.width || checked || entry.score >= 10000 || entry.move.captured !== null,
      );
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
    stats,
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
  };
}
export type AiContext = ReturnType<typeof createAiContext>;
