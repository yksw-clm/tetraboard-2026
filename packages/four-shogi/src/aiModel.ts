import type { ModelFeatures } from "./modelFeatureEncoding";
import type { AiControl, AiEvaluation } from "./aiTypes";
import { sides, getActiveSides, type FourShogiState } from "./types";

export type AiModelInput = {
  id: string;
  restricted: boolean;
  features: ModelFeatures;
  legalActionIds: number[];
};
export type AiModelOutput = {
  id: string;
  legalActionIds: number[];
  policyLogits: number[];
  policy: number[];
  topActionId: number;
  value: number[];
  illegalPolicyNonzero: number;
};
export type AiModelEvaluator = Readonly<{
  modelId: string;
  evaluate: (
    rows: readonly AiModelInput[],
    signal?: AbortSignal,
  ) => Promise<{ modelId: string; rows: AiModelOutput[] }>;
}>;
/** ローカルtinyモデル用の同期境界。正本のルール判定は呼出側に残す。 */
export type AiSyncModel = Readonly<{
  modelId: string;
  predict: (input: AiModelInput) => AiModelOutput;
}>;
export class AiModelFailure extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** process/HTTPを共通探索へ持ち込まず、注入境界のID・合法手・席・有限値を検証します。 */
export function validateModelOutputs(
  inputs: readonly AiModelInput[],
  outputs: readonly AiModelOutput[],
) {
  if (!Array.isArray(outputs) || outputs.length !== inputs.length)
    throw new AiModelFailure("invalid_output", "推論件数が不一致です");
  outputs.forEach((output: AiModelOutput, index: number) => {
    const input = inputs[index],
      ids = input.legalActionIds;
    if (
      output.id !== input.id ||
      JSON.stringify(output.legalActionIds) !== JSON.stringify(ids) ||
      output.policy.length !== ids.length ||
      output.policyLogits.length !== ids.length ||
      output.value.length !== 5 ||
      output.illegalPolicyNonzero !== 0
    )
      throw new AiModelFailure("invalid_output", "モデルの合法手ID/席/次元が不一致です");
    for (const values of [output.policy, output.value])
      if (
        values.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
        Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-5
      )
        throw new AiModelFailure("invalid_output", "モデルの分布が不正です");
    if (
      output.policyLogits.some((v) => !Number.isFinite(v)) ||
      output.topActionId !== ids[output.policyLogits.indexOf(Math.max(...output.policyLogits))]
    )
      throw new AiModelFailure("invalid_output", "モデルのlogit/最良手が不正です");
    const current = input.features.current;
    for (let side = 0; side < 4; side++) {
      if (!current.indices.includes(2689 + side) && output.value[side] !== 0)
        throw new AiModelFailure("invalid_output", "脱落した席のValueが0ではありません");
    }
  });
}

export function modelEvaluation(state: FourShogiState, prediction: AiModelOutput): AiEvaluation {
  const active = getActiveSides(state);
  const primary = sides.map((side, index) =>
    active.includes(side)
      ? Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, prediction.value[index]))
      : 0,
  );
  const ranks = sides.map((side, index) => ({
    side,
    rank:
      state.eliminations.find((entry) => entry.side === side)?.rank ??
      1 + active.filter((other) => primary[sides.indexOf(other)] > primary[index]).length,
    kind: active.includes(side) ? ("provisional" as const) : ("confirmed" as const),
  }));
  return {
    evaluationKind: "model",
    probabilities: null,
    ranks,
    values: Object.fromEntries(
      sides.map((side, index) => [
        side,
        { primary: primary[index], secondaryRank: ranks[index].rank, heuristicScore: null },
      ]),
    ) as AiEvaluation["values"],
  };
}

export function createModelDriver(
  evaluator: AiModelEvaluator,
  timeoutMs: number,
  now: () => number,
) {
  const fixedModelId = evaluator.modelId;
  const evaluate = evaluator.evaluate.bind(evaluator);
  let pending: { inputs: AiModelInput[]; accept: (rows: AiModelOutput[]) => void } | null = null;
  const stats = {
    inferenceCalls: 0,
    inferenceCount: 0,
    policyUses: 0,
    valueUses: 0,
    inferenceMs: 0,
  };
  function* request(inputs: AiModelInput[]): Generator<number, AiModelOutput[]> {
    // 注入先の変更で、同じ要求の合法手や履歴を後から差し替えられないようにします。
    for (const input of inputs) {
      for (const sparse of [input.features.current, ...input.features.history]) {
        Object.freeze(sparse.indices);
        Object.freeze(sparse.values);
        Object.freeze(sparse);
      }
      Object.freeze(input.features.history);
      Object.freeze(input.features);
      Object.freeze(input.legalActionIds);
      Object.freeze(input);
    }
    Object.freeze(inputs);
    let result: AiModelOutput[] | undefined;
    pending = {
      inputs,
      accept: (rows) => {
        result = rows;
      },
    };
    yield 0;
    if (!result) throw new Error("モデル応答を待たずに探索を再開しました");
    return result;
  }
  async function fulfill(remainingMs: number | null, control: AiControl) {
    const current = pending;
    if (!current) return;
    pending = null;
    const started = now();
    const deadline = remainingMs !== null && remainingMs <= timeoutMs;
    const limit = Math.max(0, Math.min(timeoutMs, remainingMs ?? timeoutMs));
    const controller = new AbortController();
    stats.inferenceCalls++;
    try {
      const result = await new Promise<{ modelId: string; rows: AiModelOutput[] }>(
        (resolve, reject) => {
          let settled = false;
          const finish = (error: unknown, value?: { modelId: string; rows: AiModelOutput[] }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (poll) clearInterval(poll);
            control.signal?.removeEventListener("abort", cancel);
            if (error) {
              controller.abort(error);
              reject(error);
            } else resolve(value!);
          };
          const cancel = () =>
            finish(new AiModelFailure("cancelled", "モデル推論を取り消しました"));
          const timer = setTimeout(
            () =>
              finish(
                new AiModelFailure(deadline ? "deadline" : "model_timeout", "モデル推論の期限です"),
              ),
            limit,
          );
          const poll = control.isCancelled
            ? setInterval(() => {
                if (control.isCancelled?.()) cancel();
              }, 5)
            : null;
          control.signal?.addEventListener("abort", cancel, { once: true });
          if (control.signal?.aborted || control.isCancelled?.()) {
            cancel();
            return;
          }
          Promise.resolve()
            .then(() => evaluate(current.inputs, controller.signal))
            .then(
              (value) => finish(null, value),
              (error) => finish(error),
            );
        },
      );
      if (result.modelId !== fixedModelId)
        throw new AiModelFailure("model_mismatch", "実使用モデルIDが不一致です");
      let predictions: AiModelOutput[];
      try {
        predictions = structuredClone(result.rows);
        validateModelOutputs(current.inputs, predictions);
      } catch (error) {
        if (error instanceof AiModelFailure) throw error;
        throw new AiModelFailure("invalid_output", String(error));
      }
      stats.inferenceCount += predictions.length;
      current.accept(predictions);
    } catch (error) {
      if (error instanceof AiModelFailure) throw error;
      throw new AiModelFailure("model_failed", String(error));
    } finally {
      stats.inferenceMs += now() - started;
    }
  }
  return {
    stats,
    request,
    fulfill,
    get pending() {
      return pending !== null;
    },
  };
}
export type AiModelDriver = ReturnType<typeof createModelDriver>;
