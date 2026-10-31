import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInferenceFixture } from "./inferenceFixture";
import {
  currentFeatureSize,
  historyFeatureSize,
  featureVersion,
} from "../src/modelFeatureEncoding";
import { actionSpaceSize, actionEncodingVersion } from "../src/actionEncoding";

/** 推論の配線テスト用です。棋力検証や学習モデルとして使いません。 */
export async function writeZeroLocalModelFixture(directory: string) {
  const hash = (bytes: Uint8Array | string) =>
    new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const fixture = await createInferenceFixture(),
    width = 16,
    historyWidth = 4,
    shapes: Record<string, number[]> = {
      "history.0.weight": [historyWidth, historyFeatureSize],
      "history.0.bias": [historyWidth],
      "body.0.weight": [width, currentFeatureSize + historyWidth + 1],
      "body.0.bias": [width],
      "body.2.weight": [width, width],
      "body.2.bias": [width],
      "policy.weight": [actionSpaceSize, width],
      "policy.bias": [actionSpaceSize],
      "value.weight": [5, width],
      "value.bias": [5],
    },
    tensors: Record<string, { shape: number[]; offset: number; length: number }> = {};
  let offset = 0;
  for (const [name, shape] of Object.entries(shapes)) {
    const length = shape.reduce((a, b) => a * b, 1);
    tensors[name] = { shape, offset, length };
    offset += length;
  }
  const weights = new Uint8Array(offset * 4),
    weightsSha = hash(weights),
    modelId = "four-shogi-tiny-policy-value-v1:" + "3".repeat(64),
    expected = fixture.rows.map((row) => {
      const active = [0, 1, 2, 3, 4].map(
        (i) => i === 4 || row.features.current.indices.includes(2689 + i),
      );
      return {
        id: row.id,
        legalActionIds: row.legalActionIds,
        policyLogits: row.legalActionIds.map(() => 0),
        policy: row.legalActionIds.map(() => 1 / row.legalActionIds.length),
        topActionId: row.legalActionIds[0],
        value: active.map((alive) => Number(alive) / active.filter(Boolean).length),
        illegalPolicyNonzero: 0,
      };
    }),
    probe = JSON.stringify({ rows: fixture.rows, expected }),
    source = JSON.stringify({
      modelId,
      config: { width, historyWidth },
      probe: { sha256: hash(probe) },
    }),
    meta = JSON.stringify({
      format: "four-shogi-local-f32-v1",
      calibrated: false,
      modelId,
      modelVersion: "four-shogi-tiny-policy-value-v1",
      featureVersion,
      actionEncodingVersion,
      rulesVersion: 1,
      ruleProfileId: "tetraboard-four-shogi-singles-v1",
      valueOrder: ["south", "west", "north", "east", "noSoleWinner"],
      supportedRestrictions: [false, true],
      config: { width, historyWidth },
      sourceManifestSha256: hash(source),
      weights: { file: weightsSha + ".f32", sha256: weightsSha, bytes: weights.length },
      tensors,
    });
  writeFileSync(join(directory, weightsSha + ".f32"), weights);
  writeFileSync(join(directory, "manifest.json"), source);
  writeFileSync(join(directory, "probe.json"), probe);
  writeFileSync(join(directory, "local-model.json"), meta);
  return { file: join(directory, "local-model.json"), modelId, meta, fixture, expected };
}
