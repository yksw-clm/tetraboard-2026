import {
  applyLegalPlacement,
  getActiveColors,
  getLegalPlacements,
  type Color,
  type FourReversiState,
  type Position,
} from "./engine";
import {
  evaluatePosition,
  resolveWeights,
  teamForColor,
  type EvaluationWeights,
  type PositionValues,
} from "./cpuEvaluation";
import type { LegalPlacement } from "./moves";

export type SearchOptions = {
  maxWork?: number;
  maxDepth?: number;
  width?: number;
  cacheLimit?: number;
  endgameEmpties?: number;
  evaluationWeights?: Partial<EvaluationWeights>;
  policyForecast?: boolean;
};
export const defaultSearchOptions = {
  maxWork: 262144,
  maxDepth: 6,
  width: 6,
  cacheLimit: 2048,
  endgameEmpties: 6,
  policyForecast: true,
} as const;
export type SearchStats = {
  algorithm: "maxn" | "alpha-beta";
  selection: "tree" | "forecast";
  work: number;
  nodes: number;
  generatedMoves: number;
  rootMoves: number;
  completedDepth: number;
  cutoff: boolean;
  cacheHits: number;
  cacheEntries: number;
  fallbackScans: number;
  exactEndgame: boolean;
  forecastCompleted: boolean;
  forecastRoots: number;
  forecastPlacements: number;
};
type Candidate = {
  move: LegalPlacement;
  state: FourReversiState;
  values: PositionValues;
  index: number;
};
class SearchStopped extends Error {}
const isCorner = ({ x, y }: Position) => (x === 0 || x === 7) && (y === 0 || y === 7);
const indexOf = ({ x, y }: Position) => y * 8 + x;
export function positionKey(state: FourReversiState): string {
  return JSON.stringify([
    state.mode,
    state.board,
    state.turn,
    state.eliminatedColors,
    state.consecutivePasses,
  ]);
}

export function resolveSearchOptions(options: SearchOptions = {}) {
  const settings = { ...defaultSearchOptions, ...options };
  const { maxWork, maxDepth, width, cacheLimit, endgameEmpties, policyForecast } = settings;
  if (
    [maxWork, maxDepth, width].some((n) => !Number.isSafeInteger(n) || n < 1) ||
    !Number.isSafeInteger(cacheLimit) ||
    cacheLimit < 0 ||
    cacheLimit > 2048 ||
    !Number.isSafeInteger(endgameEmpties) ||
    endgameEmpties < 0 ||
    endgameEmpties > 8 ||
    typeof policyForecast !== "boolean"
  )
    throw new TypeError(
      "探索予算・深さ・幅は正の整数、cacheLimitは0〜2048、終盤空点は0〜8で指定してください",
    );
  return { ...settings, evaluationWeights: resolveWeights(options.evaluationWeights) };
}

export function searchCpuMove(
  input: FourReversiState,
  options: SearchOptions = {},
): { move: Position | null; stats: SearchStats } {
  const {
    maxWork,
    maxDepth,
    width,
    cacheLimit,
    endgameEmpties,
    evaluationWeights: weights,
  } = resolveSearchOptions(options);
  const stats: SearchStats = {
    algorithm:
      input.mode === "singles" && getActiveColors(input).length > 2 ? "maxn" : "alpha-beta",
    selection: "tree",
    work: 0,
    nodes: 0,
    generatedMoves: 0,
    rootMoves: 0,
    completedDepth: 0,
    cutoff: false,
    cacheHits: 0,
    cacheEntries: 0,
    fallbackScans: 0,
    exactEndgame: false,
    forecastCompleted: false,
    forecastRoots: 0,
    forecastPlacements: 0,
  };
  if (input.status === "finished") return { move: null, stats };
  stats.fallbackScans = 1;
  const fallback = getLegalPlacements(input, undefined, undefined, true)[0];
  if (!fallback) return { move: null, stats };
  const root = input.turn;
  let move = fallback.position;
  const cache = new Map<string, PositionValues>();
  const rootCandidates: Candidate[] = [];
  function spend(cost = 1) {
    if (stats.work + cost > maxWork) throw new SearchStopped();
    stats.work += cost;
  }
  function put(key: string, value: PositionValues) {
    if (cache.size < cacheLimit) cache.set(key, value);
    stats.cacheEntries = cache.size;
  }
  function evaluate(state: FourReversiState): PositionValues {
    const key = `eval:${positionKey(state)}`;
    const existing = cache.get(key);
    if (existing) {
      stats.cacheHits++;
      return existing;
    }
    spend();
    const result = evaluatePosition(state, weights, spend);
    put(key, result);
    return result;
  }
  function advance(state: FourReversiState, legal: LegalPlacement) {
    spend();
    stats.nodes++;
    return applyLegalPlacement(state, legal, spend).state;
  }
  function legalMoves(state: FourReversiState) {
    const legal = getLegalPlacements(state, undefined, spend);
    stats.generatedMoves += legal.length;
    return legal;
  }
  function ordered(state: Extract<FourReversiState, { status: "playing" }>, exact: boolean) {
    if (exact) return legalMoves(state).map((legal) => ({ legal, index: indexOf(legal.position) }));
    // 並べ替えでは合法手数の再生成を省き、読んだ葉の評価で実際の可動性を比較します。
    return legalMoves(state)
      .map((legal) => {
        spend();
        return {
          legal,
          index: indexOf(legal.position),
          score: evaluatePosition({ ...state, board: legal.board }, weights, undefined, false)[
            state.turn
          ],
        };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .filter((entry, index) => index < width || isCorner(entry.legal.position));
  }
  function explore(
    state: FourReversiState,
    depth: number,
    alpha: number,
    beta: number,
    exact = false,
  ): PositionValues {
    if (state.status === "finished" || (!exact && depth === 0)) return evaluate(state);
    const key = `${exact ? "exact" : "normal"}:${depth}:${positionKey(state)}`;
    // αβの境界値を確定値として使わないため、多人数探索の完了節点だけを再利用します。
    const existing = stats.algorithm === "maxn" ? cache.get(key) : undefined;
    if (existing) {
      stats.cacheHits++;
      return existing;
    }
    let best: PositionValues | null = null;
    let bestIndex = Infinity;
    const maximizing =
      state.mode === "singles"
        ? state.turn === root
        : teamForColor(state.turn) === teamForColor(root);
    for (const candidate of ordered(state, exact)) {
      const values = explore(advance(state, candidate.legal), depth - 1, alpha, beta, exact);
      const actor: Color = stats.algorithm === "maxn" ? state.turn : root;
      const better =
        best === null ||
        (stats.algorithm === "maxn" || maximizing
          ? values[actor] > best[actor]
          : values[actor] < best[actor]);
      if (better || (best && values[actor] === best[actor] && candidate.index < bestIndex)) {
        best = values;
        bestIndex = candidate.index;
      }
      if (stats.algorithm === "alpha-beta") {
        if (maximizing) alpha = Math.max(alpha, best![root]);
        else beta = Math.min(beta, best![root]);
        if (alpha >= beta) return best!;
      }
    }
    if (!best) throw new Error("エンジンが未処理のパス局面を返しました");
    if (stats.algorithm === "maxn") put(key, best);
    return best;
  }
  try {
    const legal = legalMoves(input);
    stats.rootMoves = legal.length;
    const empties = input.board.flat().filter((cell) => cell === null).length;
    if (empties <= endgameEmpties) {
      let bestScore = -Infinity;
      let bestMove = move;
      for (const candidate of legal) {
        const score = explore(advance(input, candidate), empties - 1, -Infinity, Infinity, true)[
          root
        ];
        if (score > bestScore) {
          bestScore = score;
          bestMove = candidate.position;
        }
      }
      move = bestMove;
      stats.completedDepth = empties;
      stats.exactEndgame = true;
      return { move, stats };
    }
    for (const candidate of legal) {
      const state = advance(input, candidate);
      rootCandidates.push({
        move: candidate,
        state,
        values: evaluate(state),
        index: indexOf(candidate.position),
      });
    }
    rootCandidates.sort((a, b) => b.values[root] - a.values[root] || a.index - b.index);
    move = rootCandidates[0].move.position;
    stats.completedDepth = 1;
    for (let depth = 2; depth <= maxDepth; depth++) {
      let best = rootCandidates[0];
      let bestScore = -Infinity;
      for (const candidate of rootCandidates) {
        const score = explore(candidate.state, depth - 1, -Infinity, Infinity)[root];
        if (score > bestScore || (score === bestScore && candidate.index < best.index)) {
          best = candidate;
          bestScore = score;
        }
      }
      move = best.move.position;
      stats.completedDepth = depth;
    }
  } catch (error) {
    if (!(error instanceof SearchStopped)) throw error;
    stats.cutoff = true;
    if (stats.completedDepth === 0 && rootCandidates.length) {
      rootCandidates.sort((a, b) => b.values[root] - a.values[root] || a.index - b.index);
      move = rootCandidates[0].move.position;
    }
  }
  return { move, stats };
}
