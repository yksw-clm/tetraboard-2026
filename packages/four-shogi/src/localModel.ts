import { readFileSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  validateModelOutputs,
  type AiModelInput,
  type AiModelOutput,
  type AiSyncModel,
} from "./aiModel";
import {
  currentFeatureSize,
  historyFeatureSize,
  featureVersion,
  type SparseFeatures,
} from "./modelFeatureEncoding";
import { actionEncodingVersion, actionSpaceSize } from "./actionEncoding";

function read(path: string, limit: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error("モデルの欠落・symlink・容量上限です");
  return readFileSync(path);
}
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const softmax = (values: number[]) => {
  const largest = Math.max(...values),
    weights = values.map((v) => Math.exp(v - largest));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((v) => v / total);
};
/** Python checkpointを変更せず、同じtiny演算を疎入力・合法Policy行だけ計算する。 */
export function loadLocalModel(
  path: string,
  expectedModelId?: string,
  expectedManifestSha256?: string,
): AiSyncModel & { bytes: number; historyCacheEntries: () => number } {
  const directory = dirname(path),
    manifestBytes = read(path, 1024 ** 2),
    meta = JSON.parse(manifestBytes.toString());
  if (expectedManifestSha256 !== undefined && sha(manifestBytes) !== expectedManifestSha256)
    throw new Error("指定モデルmanifestのSHAが不一致です");
  const sourceBytes = read(join(directory, "manifest.json"), 1024 ** 2),
    source = JSON.parse(sourceBytes.toString());
  if (
    meta.format !== "four-shogi-local-f32-v1" ||
    meta.calibrated !== false ||
    meta.modelVersion !== "four-shogi-tiny-policy-value-v1" ||
    meta.featureVersion !== featureVersion ||
    meta.actionEncodingVersion !== actionEncodingVersion ||
    meta.rulesVersion !== 1 ||
    meta.ruleProfileId !== "tetraboard-four-shogi-singles-v1" ||
    JSON.stringify(meta.valueOrder) !==
      JSON.stringify(["south", "west", "north", "east", "noSoleWinner"]) ||
    !/^four-shogi-tiny-policy-value-v1:[0-9a-f]{64}$/.test(meta.modelId) ||
    (expectedModelId !== undefined && expectedModelId !== meta.modelId) ||
    sha(sourceBytes) !== meta.sourceManifestSha256 ||
    source.modelId !== meta.modelId ||
    JSON.stringify(source.config) !== JSON.stringify(meta.config)
  )
    throw new Error("localモデルの版・由来・IDが不一致です");
  const { width: w, historyWidth: h } = meta.config;
  if (
    !Number.isSafeInteger(w) ||
    w < 1 ||
    w > 256 ||
    !Number.isSafeInteger(h) ||
    h < 1 ||
    h > 64 ||
    !Array.isArray(meta.supportedRestrictions) ||
    !meta.supportedRestrictions.length ||
    meta.supportedRestrictions.some((v: unknown) => typeof v !== "boolean")
  )
    throw new Error("localモデルの構成が不正です");
  if (
    !/^[a-f0-9]{64}$/.test(meta.weights.sha256) ||
    meta.weights.file !== meta.weights.sha256 + ".f32"
  )
    throw new Error("local重みの名前が不正です");
  const bytes = read(join(directory, meta.weights.file), 32 * 1024 ** 2);
  if (bytes.length !== meta.weights.bytes || bytes.length % 4 || sha(bytes) !== meta.weights.sha256)
    throw new Error("local重みのchecksumが不一致です");
  const floats = new Float32Array(bytes.length / 4);
  for (let i = 0; i < floats.length; i++) {
    floats[i] = bytes.readFloatLE(i * 4);
    if (!Number.isFinite(floats[i])) throw new Error("local重みは有限値だけです");
  }
  const shapes: Record<string, number[]> = {
    "history.0.weight": [h, historyFeatureSize],
    "history.0.bias": [h],
    "body.0.weight": [w, currentFeatureSize + h + 1],
    "body.0.bias": [w],
    "body.2.weight": [w, w],
    "body.2.bias": [w],
    "policy.weight": [actionSpaceSize, w],
    "policy.bias": [actionSpaceSize],
    "value.weight": [5, w],
    "value.bias": [5],
  };
  const tensors: Record<string, Float32Array> = {};
  let total = 0;
  for (const [name, shape] of Object.entries(shapes)) {
    const entry = meta.tensors[name],
      length = shape.reduce((a, b) => a * b, 1);
    if (
      !entry ||
      JSON.stringify(entry.shape) !== JSON.stringify(shape) ||
      entry.offset !== total ||
      entry.length !== length
    )
      throw new Error("local tensorの次元/順序が不一致です");
    tensors[name] = floats.subarray(total, total + length);
    total += length;
  }
  if (total !== floats.length || Object.keys(meta.tensors).length !== Object.keys(shapes).length)
    throw new Error("local tensorの総量が不一致です");
  const cache = new Map<string, number[]>();
  function sparse(input: SparseFeatures, size: number) {
    if (input.indices.length !== input.values.length || input.indices.length > size)
      throw new Error("モデル疎入力が不正です");
    let prior = -1;
    input.indices.forEach((index, i) => {
      if (
        !Number.isInteger(index) ||
        index <= prior ||
        index >= size ||
        !Number.isFinite(input.values[i])
      )
        throw new Error("モデル特徴の範囲/順序が不正です");
      prior = index;
    });
  }
  function history(input: SparseFeatures) {
    const key = JSON.stringify(input),
      existing = cache.get(key);
    if (existing) return existing;
    sparse(input, historyFeatureSize);
    const values = Array.from({ length: h }, (_, row) => {
      let n = tensors["history.0.bias"][row];
      input.indices.forEach(
        (index, i) =>
          (n += tensors["history.0.weight"][row * historyFeatureSize + index] * input.values[i]),
      );
      return Math.tanh(n);
    });
    if (cache.size >= 2048) cache.delete(cache.keys().next().value!);
    cache.set(key, values);
    return values;
  }
  const predict = (input: AiModelInput): AiModelOutput => {
    if (
      !meta.supportedRestrictions.includes(input.restricted) ||
      !input.features.history.length ||
      input.features.history.length > 2048 ||
      !input.legalActionIds.length ||
      new Set(input.legalActionIds).size !== input.legalActionIds.length ||
      input.legalActionIds.some((i) => !Number.isInteger(i) || i < 0 || i >= actionSpaceSize)
    )
      throw new Error("モデル入力の設定/履歴/合法手が不正です");
    sparse(input.features.current, currentFeatureSize);
    const pooled = Array(h).fill(0),
      count = input.features.history.length;
    for (const entry of input.features.history)
      history(entry).forEach((v, i) => (pooled[i] += v / Math.sqrt(count)));
    const body0 = Array.from({ length: w }, (_, row) => {
      const stride = currentFeatureSize + h + 1,
        weights = tensors["body.0.weight"];
      let n = tensors["body.0.bias"][row];
      input.features.current.indices.forEach(
        (index, i) => (n += weights[row * stride + index] * input.features.current.values[i]),
      );
      pooled.forEach((v, i) => (n += weights[row * stride + currentFeatureSize + i] * v));
      n += (weights[row * stride + currentFeatureSize + h] * count) / 2048;
      return Math.max(0, n);
    });
    const dense = (name: string, row: number, hidden: number[]) => {
      let n = tensors[name + ".bias"][row];
      for (let i = 0; i < hidden.length; i++)
        n += tensors[name + ".weight"][row * hidden.length + i] * hidden[i];
      return n;
    };
    const hidden = Array.from({ length: w }, (_, row) => Math.max(0, dense("body.2", row, body0)));
    const logits = input.legalActionIds.map((id) => dense("policy", id, hidden));
    const alive = new Set(input.features.current.indices);
    const result = {
      id: input.id,
      legalActionIds: [...input.legalActionIds],
      policyLogits: logits,
      policy: softmax(logits),
      topActionId: input.legalActionIds[logits.indexOf(Math.max(...logits))],
      value: softmax(
        Array.from({ length: 5 }, (_, i) =>
          i === 4 || alive.has(2689 + i) ? dense("value", i, hidden) : -Infinity,
        ),
      ),
      illegalPolicyNonzero: 0,
    };
    validateModelOutputs([input], [result]);
    return result;
  };
  const probe = JSON.parse(read(join(directory, "probe.json"), 16 * 1024 ** 2).toString());
  if (sha(read(join(directory, "probe.json"), 16 * 1024 ** 2)) !== source.probe.sha256)
    throw new Error("local probeのchecksumが不一致です");
  probe.rows.forEach((row: AiModelInput, i: number) => {
    const output = predict(row),
      expected = probe.expected[i];
    for (const key of ["policyLogits", "policy", "value"] as const)
      output[key].forEach((v, j) => {
        if (Math.abs(v - expected[key][j]) > 1e-5 + Math.abs(expected[key][j]) * 1e-4)
          throw new Error("PyTorchとlocal推論の許容誤差を超えています");
      });
    if (output.topActionId !== expected.topActionId)
      throw new Error("PyTorchとlocal推論の最良手が不一致です");
  });
  return {
    modelId: meta.modelId,
    predict,
    bytes: bytes.length,
    historyCacheEntries: () => cache.size,
  };
}
