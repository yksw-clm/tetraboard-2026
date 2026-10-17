import { test, expect } from "bun:test";
import { analyzePosition, type AiControl, type AiOptions } from "../src/ai";
import {
  restoreAnalysisPosition,
  getAnalysisLegalActions,
  advanceAnalysisPosition,
} from "../src/analysis";
import { encodeAction, decodeAction } from "../src/actionEncoding";
import { encodeModelFeatures, type ModelFeatures } from "../src/modelFeatures";
import archive from "../../../test-fixtures/matches/shogi-singles.json";
import {
  createDataManifest,
  defaultSelfPlayConfig,
  gamePlans,
  type GameArtifact,
} from "../bench/selfPlayData";
import { generateSelfPlayGame } from "../bench/selfPlayGame";
import { validateGameArtifact } from "../bench/selfPlayInspect";
import { modelTacticalPositions } from "../bench/modelSearchTactics";

const modelId = "four-shogi-tiny-policy-value-v1:" + "1".repeat(64);
const options = { codeVersion: "model-test", modelId, maxWork: 5000, maxDepth: 1, extensions: 0 };
const start = (restricted = true) =>
  restoreAnalysisPosition({
    schemaVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    rulesVersion: 1,
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: restricted,
    },
    events: [],
  });
type Input = { id: string; restricted: boolean; features: ModelFeatures; legalActionIds: number[] };
function evaluator(target?: number, highPolicy = true) {
  const inputs: Input[] = [];
  return {
    modelId,
    inputs,
    async evaluate(rows: readonly Input[]) {
      inputs.push(...structuredClone(rows));
      return {
        modelId,
        rows: rows.map((row) => {
          const f = row.features.current;
          const previous = Math.round((f.values[f.indices.indexOf(4476)] ?? 0) * 13446) - 1;
          const south = target === undefined ? 0.2 : previous === target ? 0.85 : 0.05;
          const ids = row.legalActionIds;
          const topActionId = highPolicy ? ids.at(-1)! : ids[0];
          const values = [south, 0.02, 0.02, 0.02].map((value, index) =>
            f.indices.includes(2689 + index) ? value : 0,
          );
          return {
            id: row.id,
            legalActionIds: ids,
            policy: ids.map((id) => Number(id === topActionId)),
            policyLogits: ids.map((id) => (id === topActionId ? 1 : 0)),
            topActionId,
            value: [...values, 1 - values.reduce((a, b) => a + b, 0)],
            illegalPolicyNonzero: 0,
          };
        }),
      };
    },
  };
}

test("注入したValueが根の推奨手へ反映され、PolicyとValueの実使用を診断できる", async () => {
  const position = await start();
  const target = encodeAction(getAnalysisLegalActions(position).at(-1)!);
  const model = evaluator(target);
  const result = await analyzePosition(
    position,
    options as AiOptions,
    { modelEvaluator: model, now: () => 0 } as AiControl,
  );
  expect(result.recommendedAction).toEqual(decodeAction(target));
  expect(result.evaluation?.evaluationKind).toBe("model");
  expect(result.model.usedModelId).toBe(modelId);
  expect(result.model.inferenceCount).toBeGreaterThan(0);
  expect(result.evaluation?.probabilities).toBeNull();
});

test("探索枝のモデル入力は元履歴と枝の反復辞書を合わせ、入力とON/OFFを維持する", async () => {
  for (const restricted of [false, true]) {
    const position = await restoreAnalysisPosition({
      schemaVersion: 1,
      ruleProfileId: "tetraboard-four-shogi-singles-v1",
      rulesVersion: 1,
      initial: {
        mode: "singles",
        players: { south: "s", west: "w", north: "n", east: "e" },
        threePlayerAttackProhibited: restricted,
      },
      events: archive.events,
      eventOffset: 26,
    });
    const original = JSON.stringify(position);
    const expected = await advanceAnalysisPosition(position, {
      type: "action",
      side: position.state.turn,
      action: getAnalysisLegalActions(position)[0],
    });
    const model = evaluator();
    const result = await analyzePosition(position, options, {
      modelEvaluator: model,
      now: () => 0,
    });
    expect(result.model.usedModelId).toBe(modelId);
    expect(
      model.inputs.some(
        (row) => JSON.stringify(row.features) === JSON.stringify(encodeModelFeatures(expected)),
      ),
    ).toBe(true);
    expect(model.inputs.every((row) => row.restricted === restricted)).toBe(true);
    expect(JSON.stringify(position)).toBe(original);
  }
});

test("モデルがない/ロード失敗/不一致ならモデル未使用の従来探索を返す", async () => {
  const position = await start();
  const original = await analyzePosition(position, { ...options, modelId: null }, { now: () => 0 });
  for (const control of [
    {},
    { modelLoadError: "missing weights" },
    {
      modelEvaluator: {
        ...evaluator(),
        modelId: "four-shogi-tiny-policy-value-v1:" + "2".repeat(64),
      },
    },
  ]) {
    const result = await analyzePosition(position, options, { ...control, now: () => 0 });
    expect(result.candidates).toEqual(original.candidates);
    expect(result.model.usedModelId).toBeNull();
    expect(result.model.inferenceCount).toBe(0);
    expect(result.model.fallbackReason).toBeTruthy();
    expect(result.versions.evaluationVersion).toBe(original.versions.evaluationVersion);
    expect(result.cacheKey).not.toBe(original.cacheKey);
  }
});

test("途中のモデル障害は全モデル比較を破棄し、workをリセットせず従来尺度へ戻す", async () => {
  const position = await start();
  const good = evaluator();
  let calls = 0;
  const result = await analyzePosition(
    position,
    { ...options, maxDepth: 3 },
    {
      now: () => 0,
      modelEvaluator: {
        modelId,
        evaluate: async (rows, _signal) => {
          if (++calls === 4) throw new Error("worker stopped");
          return good.evaluate(rows);
        },
      },
    },
  );
  expect(result.model.fallbackReason).toBe("model_failed");
  expect(result.model.attemptedInferenceCount).toBeGreaterThan(0);
  expect(result.model.inferenceCount).toBe(0);
  expect(result.model.usedModelId).toBeNull();
  expect(result.model.discardedWork).toBeGreaterThan(0);
  expect(result.diagnostics.work).toBeLessThanOrEqual(options.maxWork);
  expect(
    result.candidates.every((candidate) => candidate.evaluation?.evaluationKind !== "model"),
  ).toBe(true);
});

test("不正なモデル分布と遅延は失敗理由を返し、従来評価へ戻す", async () => {
  const position = await start();
  const good = evaluator();
  const invalid = await analyzePosition(position, options, {
    now: () => 0,
    modelEvaluator: {
      modelId,
      evaluate: async (rows) => {
        const result = await good.evaluate(rows);
        result.rows[0].value[0] = NaN;
        return result;
      },
    },
  });
  expect(invalid.model.fallbackReason).toBe("invalid_output");
  const late = await analyzePosition(
    position,
    { ...options, modelTimeoutMs: 1 },
    { now: () => 0, modelEvaluator: { modelId, evaluate: () => new Promise(() => {}) } },
  );
  expect(late.model.fallbackReason).toBe("model_timeout");
  expect(late.evaluation?.evaluationKind).toBe("heuristic");
});

test("推論中に評価器のIDを差し替えても開始時のモデル照合を迂回できない", async () => {
  const position = await start();
  const good = evaluator();
  const changing = {
    modelId,
    evaluate: async (rows: readonly Input[]) => {
      changing.modelId = "four-shogi-tiny-policy-value-v1:" + "9".repeat(64);
      return { ...(await good.evaluate(rows)), modelId: changing.modelId };
    },
  };
  const result = await analyzePosition(position, options, {
    modelEvaluator: changing,
    now: () => 0,
  });
  expect(result.model.loadedModelId).toBe(modelId);
  expect(result.model.usedModelId).toBeNull();
  expect(result.model.fallbackReason).toBe("model_mismatch");
});

test("推論中の取消を伝え、期限後の応答を候補へ採用しない", async () => {
  const position = await start();
  const controller = new AbortController();
  let propagated = false;
  const result = await analyzePosition(position, options, {
    signal: controller.signal,
    now: () => 0,
    modelEvaluator: {
      modelId,
      evaluate: async (_rows, signal) => {
        signal?.addEventListener(
          "abort",
          () => {
            propagated = true;
          },
          { once: true },
        );
        controller.abort();
        return new Promise(() => {});
      },
    },
  });
  expect(result.status).toBe("cancelled");
  expect(propagated).toBe(true);
  expect(result.model.usedModelId).toBeNull();
  let time = 0;
  const good = evaluator();
  const expired = await analyzePosition(
    position,
    { ...options, timeBudgetMs: 10 },
    {
      now: () => time,
      modelEvaluator: {
        modelId,
        evaluate: async (rows) => {
          time = 11;
          return good.evaluate(rows);
        },
      },
    },
  );
  expect(expired.diagnostics.stopReason).toBe("deadline");
  expect(expired.diagnostics.completedDepth).toBe(0);
  expect(expired.evaluation).toBeNull();
});

test("終局はモデルに問い合わせず正本の単独1位ラベルを使う", async () => {
  const position = await restoreAnalysisPosition({
    schemaVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    rulesVersion: 1,
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: true,
    },
    events: archive.events,
  });
  const model = evaluator();
  const result = await analyzePosition(position, options, { modelEvaluator: model, now: () => 0 });
  expect(result.status).toBe("terminal");
  expect(result.evaluation?.values.north.primary).toBe(1);
  expect(result.evaluation?.evaluationKind).toBe("terminal");
  expect(model.inputs).toHaveLength(0);
  expect(result.model.usedModelId).toBeNull();
});

test("非終局Valueが1を返しても、両設定の正本で確定した単独勝ちを優先する", async () => {
  for (const row of await modelTacticalPositions()) {
    const good = evaluator();
    const root = ["south", "west", "north", "east"].indexOf(row.position.state.turn!);
    const result = await analyzePosition(
      row.position,
      { ...options, maxWork: 10000 },
      {
        now: () => 0,
        modelEvaluator: {
          modelId,
          evaluate: async (inputs) => {
            const response = await good.evaluate(inputs);
            response.rows.forEach((output, index) => {
              const alive = inputs[index].features.current.indices.includes(2689 + root);
              output.value = [0, 0, 0, 0, 0];
              output.value[alive ? root : 4] = 1;
            });
            return response;
          },
        },
      },
    );
    expect(row.winningActionIds).toContain(encodeAction(result.recommendedAction!));
    expect(result.evaluation?.evaluationKind).toBe("terminal");
    expect(result.evaluation?.values[row.position.state.turn!].primary).toBe(1);
  }
});

test("対局選択と教師生成は同じモデルを使い、中断再開後も同じ結果になりfallback教師を拒否する", async () => {
  const manifest = await createDataManifest(
    {
      ...defaultSelfPlayConfig(),
      model: { modelId, artifactSha256: "2".repeat(64), codeHash: "3".repeat(64) },
      origins: [{ seed: 19200 }],
      restrictions: [true],
      seatOffsets: ["south"],
      agents: [
        {
          id: "model",
          kind: "analysis",
          options: { maxWork: 2048, maxDepth: 2, rootWidth: 5, width: 1, extensions: 0 },
        },
      ],
      lineups: [["model", "model", "model", "model"]],
      teacher: { maxWork: 2048, maxDepth: 2, rootWidth: 5, width: 1, extensions: 0 },
      sampling: { every: 1, important: false, maxPositions: 2 },
      maxPlies: 2,
    },
    {
      commit: "0".repeat(40),
      dirty: false,
      sourceHash: "1".repeat(64),
      runnerHash: "2".repeat(64),
      runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    },
  );
  const plan = gamePlans(manifest)[0];
  const control = { now: () => 0, yieldToHost: async () => {}, modelEvaluator: evaluator() };
  const continuous = await generateSelfPlayGame(manifest, plan, null, async () => {}, control);
  let saved: GameArtifact | null = null;
  await expect(
    generateSelfPlayGame(
      manifest,
      plan,
      null,
      async (record) => {
        saved = structuredClone(record);
        if (record.actors.length === 1) throw new Error("pause");
      },
      control,
    ),
  ).rejects.toThrow("pause");
  const resumed = await generateSelfPlayGame(manifest, plan, saved, async () => {}, control);
  expect(resumed).toEqual(continuous);
  expect(
    resumed.samples.every(
      (sample) =>
        sample.teacher.model.usedModelId === modelId && sample.teacher.model.inferenceCount > 0,
    ),
  ).toBe(true);
  expect(resumed.outcome).toBeNull();
  await validateGameArtifact(manifest, plan, resumed);
  const bad = structuredClone(resumed);
  bad.samples[0].teacher = {
    ...bad.samples[0].teacher,
    model: { ...bad.samples[0].teacher.model, usedModelId: null },
  };
  await expect(validateGameArtifact(manifest, plan, bad)).rejects.toThrow("混在");
  await expect(
    generateSelfPlayGame(manifest, plan, null, async () => {}, { now: () => 0 }),
  ).rejects.toThrow("fallback教師");
});

test("同じValueでもPolicyが幅制限内の応手と読み筋を変える", async () => {
  const position = await start(false);
  const config = { ...options, maxDepth: 2, width: 1, rootWidth: 5 };
  const high = await analyzePosition(
    position,
    config as AiOptions,
    { modelEvaluator: evaluator(undefined, true), now: () => 0 } as AiControl,
  );
  const low = await analyzePosition(
    position,
    config as AiOptions,
    { modelEvaluator: evaluator(undefined, false), now: () => 0 } as AiControl,
  );
  expect(high.diagnostics.completedDepth).toBe(2);
  expect(low.diagnostics.completedDepth).toBe(2);
  expect(high.candidates[0].line[1].action).not.toEqual(low.candidates[0].line[1].action);
});
