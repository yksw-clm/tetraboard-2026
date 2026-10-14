import { getCheckState } from "./board";
import { priority } from "./cpuSearch";
import { evaluateAiPosition } from "./aiEvaluation";
import { getLegalMoves, applyLegalMove } from "./transition";
import { getActiveSides, type FourShogiState, type Side } from "./types";
import type { OrdinaryMove } from "./moves";
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
export function createAiContext(input: FourShogiState, settings: AiSearchSettings) {
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
    const value = evaluateAiPosition(state, settings.evaluationWeights);
    stats.evaluations++;
    if (record) record.evaluation = value;
    return value;
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
  function ordered(state: FourShogiState, legalMoves: OrdinaryMove[]) {
    const record = node(state);
    let selected = record?.ordered;
    if (selected) stats.orderingCacheHits++;
    else {
      const checked = getCheckState(state)[state.turn!];
      selected = legalMoves
        .map((move, index) => ({ move, index, score: priority(move, state.turn!) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .filter(
          (entry, index) =>
            index < settings.width ||
            checked ||
            entry.score >= 10000 ||
            entry.move.captured !== null,
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
  };
}
export type AiContext = ReturnType<typeof createAiContext>;
