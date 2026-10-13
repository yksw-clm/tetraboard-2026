import { getCheckState, pieces, attackedPositions } from "./board";
import { requiresAttackFiltering } from "./attacks";
import { validateOrdinaryAction, type OrdinaryMove } from "./moves";
import {
  defaultEvaluationWeights,
  evaluatePosition,
  pieceValue,
  type EvaluationWeights,
} from "./cpuEvaluation";
import { applyLegalMove, getLegalMoves } from "./transition";
import {
  getActiveSides,
  type FourShogiState,
  type FourShogiAction,
  type Side,
  type Piece,
} from "./types";
import type { RepetitionLookup } from "./repetition";

export const lv3Weights: EvaluationWeights = /* @__PURE__ */ Object.freeze({
  ...defaultEvaluationWeights,
  undefended: 1.6,
  exchange: 0.9,
  check: 70,
  kingRing: 55,
  shelter: 18,
});
export type Lv3Options = {
  maxWork?: number;
  maxDepth?: number;
  width?: number;
  rootWidth?: number;
  weights?: EvaluationWeights;
  onProgress?: (result: Lv3Result) => void;
  onRootCandidates?: (candidates: readonly Lv3RootCandidate[]) => void;
};
export type Lv3RootCandidate = {
  action: FourShogiAction;
  state: FourShogiState;
  risk: number;
  score: number;
  index: number;
};
export { evaluatePosition as evaluateLv3Position } from "./cpuEvaluation";
export type Lv3Result = {
  action: FourShogiAction | null;
  stats: {
    work: number;
    completedDepth: number;
    safetyComplete: boolean;
    cutoff: boolean;
    algorithm: "maxn" | "alpha-beta";
  };
};
class BudgetReached extends Error {}
type Values = Record<Side, number>;

/** Lv2とは独立して全候補の合法交換を比較し、完了した探索深さだけを採用します。 */
export function chooseLv3Action(
  input: FourShogiState,
  options: Lv3Options = {},
  lookup?: RepetitionLookup,
): Lv3Result {
  if (input.mode !== "singles") throw new TypeError("Lv3 supports singles only");
  const maxWork = options.maxWork ?? 16_384;
  const maxDepth = options.maxDepth ?? 6;
  const width = options.width ?? 6;
  const rootWidth = options.rootWidth ?? 12;
  if ([maxWork, maxDepth, width, rootWidth].some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new TypeError("Invalid search budget");
  const weights = options.weights ?? lv3Weights;
  if (
    Object.keys(lv3Weights).some(
      (k) =>
        !Number.isFinite(weights[k as keyof EvaluationWeights]) ||
        weights[k as keyof EvaluationWeights] < 0,
    )
  )
    throw new TypeError("Invalid evaluation weights");
  const stats: Lv3Result["stats"] = {
    work: 0,
    completedDepth: 0,
    safetyComplete: false,
    cutoff: false,
    algorithm: getActiveSides(input).length === 2 ? "alpha-beta" : "maxn",
  };
  if (input.status === "finished") return { action: null, stats };
  const root = input.turn;
  const history: RepetitionLookup = (key) => input.repetitions[key] ?? lookup?.(key) ?? 0;
  const state = { ...input, repetitions: {} } as FourShogiState;
  const spend = (n = 1) => {
    if (stats.work + n > maxWork) throw new BudgetReached();
    stats.work += n;
  };
  const moves = (s: FourShogiState) => {
    spend();
    const result = getLegalMoves(s);
    spend(Math.ceil(result.length / 16));
    return result;
  };
  const advance = (s: FourShogiState, move: ReturnType<typeof getLegalMoves>[number]) => {
    spend();
    return applyLegalMove(s, s.turn!, move, history).state;
  };
  const legal = getLegalMoves(state);
  if (!legal.length) return { action: null, stats };
  const ordered = legal
    .map((move, index) => ({ move, index, value: evaluatePosition(move.state, weights)[root] }))
    .sort((a, b) => b.value - a.value || a.index - b.index);
  let action = ordered[0].move.action;
  const publish = () => options.onProgress?.({ action, stats: { ...stats } });
  publish();

  const evaluationCache = new WeakMap<FourShogiState, Values>();
  const evaluate = (position: FourShogiState) => {
    const cached = evaluationCache.get(position);
    if (cached) return cached;
    const value = evaluatePosition(position, weights);
    evaluationCache.set(position, value);
    return value;
  };
  function captures(position: FourShogiState): OrdinaryMove[] {
    if (position.status === "finished") return [];
    if (requiresAttackFiltering(position, position.turn))
      return moves(position).filter((move) => move.captured !== null);
    // 駒打ちの全展開を省きます。攻撃禁止の例外判定が必要な局面は通常の全候補生成を使います。
    spend();
    const result: OrdinaryMove[] = [];
    for (const located of pieces(position.board).filter((p) => p.piece.side === position.turn)) {
      for (const to of attackedPositions(position.board, located.piece, located.position)) {
        const target: Piece | null = position.board[to.y][to.x];
        if (!target || target.side === position.turn || target.kind === "king") continue;
        for (const promote of [false, true]) {
          const validation = validateOrdinaryAction(position, position.turn, {
            type: "movePiece",
            from: located.position,
            to,
            promote,
          });
          if (validation.ok) result.push(validation.move);
        }
      }
    }
    spend(Math.ceil(result.length / 16));
    return result;
  }

  // 利きだけでは取り返しを保証できません。ピン・自王の王手・攻撃禁止は共通の合法手生成で除外します。
  function exposure(next: FourShogiState): number {
    if (next.status === "finished") return 0;
    let worst = 0;
    for (const enemy of getActiveSides(next).filter((s) => s !== root)) {
      const immediate = next.turn === enemy;
      const hypothetical = { ...next, turn: enemy } as FourShogiState;
      for (const capture of captures(hypothetical).filter((m) => m.captured?.side === root)) {
        const capturedValue = pieceValue(capture.captured!);
        const response = advance(hypothetical, capture);
        if (!getActiveSides(response).includes(root)) return 2_000_000;
        let recovered = 0;
        if (response.status === "playing") {
          const ownResponse = { ...response, turn: root } as FourShogiState;
          const recaptures = captures(ownResponse).filter(
            (m) =>
              m.captured?.side === enemy &&
              m.action.to.x === capture.action.to.x &&
              m.action.to.y === capture.action.to.y,
          );
          if (recaptures.length)
            recovered = Math.max(...recaptures.map((m) => pieceValue(m.captured!) * 1.5));
        }
        // 他の陣営の利益と、取った駒が相手の持ち駒になる分も数える。手番外の脅威は割り引く。
        worst = Math.max(
          worst,
          Math.max(0, capturedValue * 1.5 - recovered) * (immediate ? 1 : 0.65),
        );
      }
    }
    return worst;
  }
  const candidates: Lv3RootCandidate[] = [];
  function explore(s: FourShogiState, depth: number, alpha: number, beta: number): Values {
    if (s.status === "finished" || depth === 0) {
      spend();
      return evaluate(s);
    }
    const side = s.turn;
    const checked = getCheckState(s)[side];
    const choices = moves(s)
      .map((move, index) => ({
        move,
        index,
        score: evaluate(move.state)[side] + (move.captured ? pieceValue(move.captured) : 0),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, checked ? Math.max(width, 12) : width);
    let best: Values | undefined;
    for (const choice of choices) {
      const next = advance(s, choice.move);
      if (side !== root && !getActiveSides(next).includes(root)) return evaluate(next);
      const value = explore(next, depth - 1, alpha, beta);
      if (
        !best ||
        (stats.algorithm === "maxn"
          ? value[side] > best[side] || (value[side] === best[side] && value[root] < best[root])
          : side === root
            ? value[root] > best[root]
            : value[root] < best[root])
      )
        best = value;
      if (stats.algorithm === "alpha-beta") {
        if (side === root) alpha = Math.max(alpha, value[root]);
        else beta = Math.min(beta, value[root]);
        if (alpha >= beta) break;
      }
    }
    return best ?? evaluate(s);
  }
  try {
    for (const entry of ordered) {
      const next = advance(state, entry.move);
      if (
        next.status === "finished" &&
        next.result.mode === "singles" &&
        next.result.standings.some((s) => s.side === root && s.rank === 1)
      ) {
        action = entry.move.action;
        stats.safetyComplete = true;
        publish();
        return { action, stats };
      }
      const risk = exposure(next);
      candidates.push({
        action: entry.move.action,
        state: next,
        risk,
        score: evaluate(next)[root] - risk,
        index: entry.index,
      });
    }
    stats.safetyComplete = true;
    candidates.sort((a, b) => b.score - a.score || a.index - b.index);
    options.onRootCandidates?.(candidates);
    action = candidates[0].action;
    stats.completedDepth = 1;
    publish();
    const selected = candidates.slice(0, rootWidth);
    for (let depth = 2; depth <= maxDepth; depth++) {
      let best = selected[0],
        score = -Infinity;
      for (const candidate of selected) {
        const value =
          explore(candidate.state, depth - 1, -Infinity, Infinity)[root] - candidate.risk;
        if (value > score) {
          score = value;
          best = candidate;
        }
      }
      action = best.action;
      stats.completedDepth = depth;
      publish();
    }
  } catch (error) {
    if (!(error instanceof BudgetReached)) throw error;
    stats.cutoff = true;
    // 全候補が間に合わない場合も、合法交換を確認できた候補の最善を返す。
    if (!stats.safetyComplete && candidates.length) {
      candidates.sort((a, b) => b.score - a.score || a.index - b.index);
      action = candidates[0].action;
    }
  }
  publish();
  return { action, stats };
}
