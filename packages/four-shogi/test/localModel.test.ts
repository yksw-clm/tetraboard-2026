import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeZeroLocalModelFixture } from "../bench/localModelFixture";
import { loadLocalModel } from "../src/localModel";
import { createStateFeatureEncoder } from "../src/modelFeatureEncoding";
import { restoreAnalysisPosition } from "../src/analysis";

test("local f32モデルは合法Policyと同値のValue専用headを両ルール・各席・脱落局面で検査する", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-value-")),
    hash = (bytes: Uint8Array | string) =>
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  try {
    const { fixture, expected, modelId, meta } = await writeZeroLocalModelFixture(directory);
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
