import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInferenceFixture } from "../bench/inferenceFixture";
import { loadLocalModel } from "../src/localModel";
import {
  currentFeatureSize,
  historyFeatureSize,
  featureVersion,
  createStateFeatureEncoder,
} from "../src/modelFeatureEncoding";
import { restoreAnalysisPosition } from "../src/analysis";
import { actionSpaceSize, actionEncodingVersion } from "../src/actionEncoding";

test("local f32モデルは合法Policyと同値のValue専用headを両ルール・各席・脱落局面で検査する", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-value-")),
    hash = (bytes: Uint8Array | string) =>
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  try {
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
    const model = loadLocalModel(join(directory, "local-model.json"), modelId, hash(meta));
    const position = await restoreAnalysisPosition({
        schemaVersion: 1,
        ruleProfileId: "tetraboard-four-shogi-singles-v1",
        rulesVersion: 1,
        initial: {
          mode: "singles",
          players: { south: "s", west: "w", north: "n", east: "e" },
          threePlayerAttackProhibited: true,
        },
        events: [],
      }),
      encoder = createStateFeatureEncoder(),
      shared = { id: "shared", restricted: true, features: encoder.encode(position.state) };
    model.predictValue!(shared);
    const firstHits = model.historyReferenceHits();
    expect(model.predictValue!(shared).value).toEqual(model.predictValue!(shared).value);
    expect(model.historyReferenceHits()).toBeGreaterThan(firstHits);
    const unshared = structuredClone(shared),
      hits = model.historyReferenceHits();
    for (const entry of unshared.features.history) {
      Object.freeze(entry.indices);
      Object.freeze(entry.values);
      Object.freeze(entry);
    }
    model.predictValue!(unshared);
    model.predictValue!(unshared);
    expect(model.historyReferenceHits()).toBe(hits);
    const disabled = loadLocalModel(join(directory, "local-model.json"), modelId, hash(meta), {
      historyReferences: false,
    });
    expect(disabled.predictValue!(shared)).toEqual(model.predictValue!(shared));
    disabled.predictValue!(shared);
    expect(disabled.historyReferenceHits()).toBe(0);
    for (const [i, row] of fixture.rows.entries()) {
      const { legalActionIds: _ids, ...input } = row,
        full = model.predict(row),
        value = model.predictValue!(input);
      expect(full.value).toEqual(expected[i].value);
      expect(value.value).toEqual(full.value);
      expect(full.topActionId).toBe(row.legalActionIds[0]);
      if (row.id.includes("eliminated")) expect(value.value[1]).toBe(0);
    }
    expect(() => model.predict({ ...fixture.rows[0], legalActionIds: [] })).toThrow("合法手");
    expect(() =>
      model.predictValue!({
        ...fixture.rows[0],
        features: { ...fixture.rows[0].features, history: [] },
      }),
    ).toThrow("履歴");
    expect(() =>
      loadLocalModel(join(directory, "local-model.json"), modelId, "0".repeat(64)),
    ).toThrow("SHA");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
