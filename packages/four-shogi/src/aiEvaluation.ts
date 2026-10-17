import {
  evaluatePosition,
  defaultEvaluationWeights,
  type EvaluationWeights,
} from "./cpuEvaluation";
import { getActiveSides, sides, type FourShogiState, type Side } from "./types";
import type { AiEvaluation, AiValue } from "./aiTypes";

/** 順位を主効用へ加算せず、完全に同じ主効用だけを副順位で比較します。 */
export function compareAiValue(left: AiValue, right: AiValue): number {
  return left.primary - right.primary || right.secondaryRank - left.secondaryRank;
}

export function evaluateAiPosition(
  state: FourShogiState,
  weights: EvaluationWeights = { ...defaultEvaluationWeights, survival: 0 },
): AiEvaluation {
  if (state.mode !== "singles") throw new TypeError("新AIはシングルス専用です");
  const active = getActiveSides(state);
  const terminal = state.status === "finished";
  if (terminal && state.result.mode !== "singles") throw new TypeError("シングルス結果が必要です");
  const standings = terminal && state.result.mode === "singles" ? state.result.standings : [];
  const first = standings.filter((standing) => standing.rank === 1);
  // 生存人数による旧Lv2の順位報酬を除き、駒・配置・安全の評価を再利用します。
  const scores = terminal ? null : evaluatePosition(state, weights);
  if (scores && active.some((side) => !Number.isFinite(scores[side])))
    throw new TypeError("静的評価が有限数の範囲を超えました。評価係数を小さくしてください");
  const values = Object.fromEntries(
    sides.map((side) => {
      const confirmedRank = terminal
        ? standings.find((standing) => standing.side === side)!.rank
        : state.eliminations.find((entry) => entry.side === side)?.rank;
      const rank =
        confirmedRank ?? 1 + active.filter((other) => scores![other] > scores![side]).length;
      return [
        side,
        {
          primary: terminal
            ? Number(first.length === 1 && first[0].side === side)
            : active.includes(side)
              ? Math.max(
                  Number.EPSILON,
                  Math.min(1 - Number.EPSILON, 0.5 + Math.atan(scores![side] / 10_000) / Math.PI),
                )
              : 0,
          secondaryRank: rank,
          heuristicScore: !terminal && active.includes(side) ? scores![side] : null,
        },
      ];
    }),
  ) as Record<Side, AiValue>;
  return {
    evaluationKind: terminal ? "terminal" : "heuristic",
    values,
    ranks: sides.map((side) => ({
      side,
      rank: values[side].secondaryRank,
      kind: terminal || !active.includes(side) ? "confirmed" : "provisional",
    })),
    probabilities: null,
  };
}
