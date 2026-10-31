import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDataManifest,
  defaultSelfPlayConfig,
  gamePlans,
  type DataCode,
} from "../bench/selfPlayData";
import { generateSelfPlayGame } from "../bench/selfPlayGame";
import { SelfPlayStore } from "../bench/selfPlayStore";
import { createDatasetSnapshot, qualityGate, fileSha } from "../bench/nightlySnapshot";
import {
  initializeNightlyRoot,
  currentGeneration,
  immutableJson,
  atomicJson,
} from "../bench/nightlyStore";
const code: DataCode = {
  commit: "0".repeat(40),
  dirty: false,
  sourceHash: "1".repeat(64),
  runnerHash: "2".repeat(64),
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
};
test("集合snapshotは元datasetを保ち、二重登録・予約seed・既存先の上書きを拒否する", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-data-"));
  try {
    const source = join(root, "source"),
      manifest = await createDataManifest(
        {
          ...defaultSelfPlayConfig(),
          origins: [{ seed: 41819 }, { seed: 51819 }],
          restrictions: [true],
          seatOffsets: ["south"],
          agents: [{ id: "a", kind: "analysis", options: { maxWork: 16 } }],
          lineups: [["a", "a", "a", "a"]],
          teacher: { maxWork: 256, extensions: 0 },
          sampling: { every: 1, important: false, maxPositions: 1 },
          maxPlies: 2,
        },
        code,
      );
    const store = new SelfPlayStore(source, 16 * 1024 ** 2);
    try {
      store.writeManifest(manifest);
      for (const plan of gamePlans(manifest)) {
        const record = await generateSelfPlayGame(manifest, plan, null, async () => {});
        store.writeGame(record);
      }
    } finally {
      store.close();
    }
    const before = fileSha(join(source, "manifest.json"));
    const snapshot = await createDatasetSnapshot([source], join(root, "snapshot"));
    expect(fileSha(join(source, "manifest.json"))).toBe(before);
    expect(snapshot.quality.truncated).toBe(2);
    expect(snapshot.quality.valueClasses).toEqual([0, 0, 0, 0, 0]);
    expect(snapshot.quality.eligible).toBe(false);
    await expect(createDatasetSnapshot([source, source], join(root, "duplicate"))).rejects.toThrow(
      "重複",
    );
    await expect(createDatasetSnapshot([source], join(root, "reserved"), [41819])).rejects.toThrow(
      "予約",
    );
    await expect(createDatasetSnapshot([source], join(root, "snapshot"))).rejects.toThrow("不変");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("夜間保存先の排他と不変manifestを守り、候補を現役扱いしない", () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-lock-"));
  try {
    const store = initializeNightlyRoot(root);
    try {
      expect(currentGeneration(root).id).toBe("g000");
      expect(() => initializeNightlyRoot(root)).toThrow("別の");
      const path = join(root, "reports", "immutable.json");
      immutableJson(path, { a: 1 });
      const before = readFileSync(path, "utf8");
      expect(() => immutableJson(path, { a: 2 })).toThrow("不変");
      expect(readFileSync(path, "utf8")).toBe(before);
      atomicJson(join(root, "current.json"), { id: "missing", modelId: "wrong" });
      expect(() => currentGeneration(root)).toThrow();
    } finally {
      store.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("勝利教師が一方向だけでも品質gateを通さず、各splitを別に検査する", () => {
  const summary = {
    splits: {
      train: { families: 2, policy: 64, values: [0, 0, 0, 1000, 0] },
      validation: { families: 1, policy: 16, values: [2, 2, 2, 2, 0] },
    },
  };
  expect(qualityGate(summary).eligible).toBe(false);
  summary.splits.train.values = [8, 8, 8, 8, 0];
  expect(qualityGate(summary).eligible).toBe(true);
});
