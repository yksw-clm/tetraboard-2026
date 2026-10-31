import { getCheckState } from "./board";
import {
  evaluatePosition,
  defaultEvaluationWeights,
  type EvaluationWeights,
} from "./cpuEvaluation";
import type { OrdinaryMove } from "./moves";
import { positionKey, type RepetitionLookup } from "./repetition";
import { applyLegalMove, getLegalMoves } from "./transition";
import {
  areEnemies,
  getActiveSides,
  teamForSide,
  type FourShogiAction,
  type FourShogiState,
  type Side,
} from "./types";

export type SearchOptions = {
  maxWork?: number;
  maxDepth?: number;
  width?: number;
  rootWidth?: number;
  extensions?: number;
  evaluationWeights?: Partial<EvaluationWeights>;
  preferredAction?: FourShogiAction;
};
export type SearchStats = {
  nodes: number;
  work: number;
  generatedMoves: number;
  completedDepth: number;
  cutoff: boolean;
  algorithm: "maxn" | "alpha-beta";
  extendedNodes: number;
  cacheHits: number;
};
type Values = Record<Side, number>;
type Candidate = { action: FourShogiAction; state: FourShogiState; values: Values; index: number };
const values = { king: 0, rook: 800, gold: 500, silver: 400, pawn: 100 };
class SearchStopped extends Error {}

export function priority(
  move: OrdinaryMove,
  side: Side,
  checks = getCheckState(move.state),
): number {
  const checking = getActiveSides(move.state).some(
    (target) => areEnemies(move.state.mode, side, target) && checks[target],
  );
  const promotion =
    move.action.type === "movePiece" && move.action.promote
      ? move.piece.kind === "pawn"
        ? 400
        : 200
      : 0;
  return (move.captured ? values[move.captured.kind] * 2 : 0) + promotion + (checking ? 10_000 : 0);
}

function immediateWin(state: FourShogiState, side: Side): boolean {
  return (
    state.status === "finished" &&
    (state.result.mode === "singles"
      ? state.result.standings.some((standing) => standing.side === side && standing.rank === 1)
      : state.result.winner === teamForSide(side))
  );
}

export function searchCpuAction(
  input: FourShogiState,
  options: SearchOptions = {},
  repetitionLookup?: RepetitionLookup,
): { action: FourShogiAction | null; stats: SearchStats } {
  const maxWork = options.maxWork ?? 2048;
  const maxDepth = options.maxDepth ?? 6;
  const width = options.width ?? 6;
  const rootWidth = options.rootWidth ?? 24;
  const extensions = options.extensions ?? 2;
  const weights = { ...defaultEvaluationWeights, ...options.evaluationWeights };
  if (Object.values(weights).some((value) => !Number.isFinite(value) || value < 0))
    throw new TypeError("評価の重みは非負の有限数で指定してください");
  const evaluate = (state: FourShogiState) => evaluatePosition(state, weights);
  const preferred = JSON.stringify(options.preferredAction);
  const preference = (action: FourShogiAction) => Number(JSON.stringify(action) === preferred);
  const compareCandidates = (a: Candidate, b: Candidate) =>
    b.values[input.turn!] - a.values[input.turn!] ||
    preference(b.action) - preference(a.action) ||
    a.index - b.index;
  if (
    [maxWork, maxDepth, width, rootWidth].some((value) => !Number.isSafeInteger(value) || value < 1)
  )
    throw new TypeError("探索予算は正の整数で指定してください");
  if (!Number.isSafeInteger(extensions) || extensions < 0 || extensions > 4)
    throw new TypeError("戦術延長は0から4手で指定してください");
  const stats: SearchStats = {
    nodes: 0,
    work: 0,
    generatedMoves: 0,
    completedDepth: 0,
    cutoff: false,
    extendedNodes: 0,
    cacheHits: 0,
    algorithm:
      input.mode === "doubles" || getActiveSides(input).length === 2 ? "alpha-beta" : "maxn",
  };
  if (input.status === "finished") return { action: null, stats };
  const root = input.turn;
  const history = new Map<string, number>();
  const lookup: RepetitionLookup = (key) => {
    if (!history.has(key)) history.set(key, input.repetitions[key] ?? repetitionLookup?.(key) ?? 0);
    return history.get(key)!;
  };
  // 基底履歴を参照へ分け、探索枝では訪れた局面の回数だけを複製します。
  const start: FourShogiState = { ...input, repetitions: {} };
  const legal = getLegalMoves(start);
  stats.generatedMoves += legal.length;
  if (legal.length === 0) return { action: null, stats };
  let action = legal[0].action;
  const candidates: Candidate[] = [];
  const cache = new Map<string, Values>();
  function spend(cost = 1): void {
    if (stats.work + cost > maxWork) throw new SearchStopped();
    stats.work += cost;
  }
  function advance(state: FourShogiState, move: OrdinaryMove): FourShogiState {
    spend();
    stats.nodes++;
    return applyLegalMove(state, state.turn!, move, lookup).state;
  }
  function explore(
    state: FourShogiState,
    depth: number,
    alpha: number,
    beta: number,
    extra: number,
  ): Values {
    if (state.status === "finished") return evaluate(state);
    const checked = getCheckState(state)[state.turn];
    if (depth <= 0 && extra > 0 && (checked || state.lastMove?.captured || state.turn === root)) {
      depth = 1;
      extra--;
      stats.extendedNodes++;
    }
    const canCache = stats.algorithm === "maxn" || (alpha === -Infinity && beta === Infinity);
    const key = JSON.stringify([
      positionKey(state),
      state.eliminations,
      state.drawProposals,
      Object.entries(state.repetitions).sort(([a], [b]) => a.localeCompare(b)),
      depth,
      extra,
    ]);
    const cached = canCache ? cache.get(key) : undefined;
    if (cached) {
      stats.cacheHits++;
      return cached;
    }
    if (depth <= 0) {
      const result = evaluate(state);
      if (cache.size < 2048) cache.set(key, result);
      return result;
    }
    spend();
    const side = state.turn;
    const moves = getLegalMoves(state);
    stats.generatedMoves += moves.length;
    spend(Math.ceil(moves.length / 16));
    const ordered = moves
      .map((move, index) => ({ move, index, score: priority(move, side) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .filter(
        (entry, index) =>
          index < width || checked || entry.score >= 10_000 || entry.move.captured !== null,
      );
    let best: Values | undefined;
    const maximizing = !areEnemies(state.mode, root, side);
    for (const { move } of ordered) {
      const next = advance(state, move);
      // 相手の評価上は別の撃破が得でも、一手で自分を脱落させる応手を見逃しません。
      if (
        !maximizing &&
        (!getActiveSides(next).includes(root) ||
          (next.status === "finished" &&
            next.result.mode === "doubles" &&
            next.result.winner !== null &&
            next.result.winner !== teamForSide(root)))
      ) {
        return evaluate(next);
      }
      const child = explore(next, depth - 1, alpha, beta, extra);
      if (stats.algorithm === "maxn") {
        if (
          !best ||
          child[side] > best[side] ||
          (child[side] === best[side] && child[root] < best[root])
        )
          best = child;
      } else {
        if (!best || (maximizing ? child[root] > best[root] : child[root] < best[root]))
          best = child;
        if (maximizing) alpha = Math.max(alpha, child[root]);
        else beta = Math.min(beta, child[root]);
        if (alpha >= beta) return best;
      }
    }
    const result = best ?? evaluate(state);
    if (canCache && cache.size < 2048) cache.set(key, result);
    return result;
  }
  try {
    for (const [index, move] of legal.entries()) {
      const state = advance(start, move);
      candidates.push({ action: move.action, state, values: evaluate(state), index });
      if (immediateWin(state, root)) return { action: move.action, stats };
    }
    candidates.sort(compareCandidates);
    action = candidates[0].action;
    stats.completedDepth = 1;
    const selected = candidates.filter(
      (candidate, index) =>
        index < rootWidth ||
        candidate.state.lastMove?.captured ||
        (candidate.state.status === "playing" &&
          getCheckState(candidate.state)[candidate.state.turn]),
    );
    for (let depth = 2; depth <= maxDepth; depth++) {
      let best = selected[0];
      let score = -Infinity;
      for (const candidate of selected) {
        const candidateScore = explore(candidate.state, depth - 1, -Infinity, Infinity, extensions)[
          root
        ];
        if (
          candidateScore > score ||
          (candidateScore === score &&
            (candidate.values[root] > best.values[root] ||
              (candidate.values[root] === best.values[root] &&
                (preference(candidate.action) > preference(best.action) ||
                  (preference(candidate.action) === preference(best.action) &&
                    candidate.index < best.index)))))
        ) {
          best = candidate;
          score = candidateScore;
        }
      }
      action = best.action;
      stats.completedDepth = depth;
    }
  } catch (error) {
    if (!(error instanceof SearchStopped)) throw error;
    stats.cutoff = true;
    if (stats.completedDepth === 0 && candidates.length > 0) {
      candidates.sort(compareCandidates);
      action = candidates[0].action;
    }
  }
  return { action, stats };
}
