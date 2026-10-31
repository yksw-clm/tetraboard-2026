import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createDatasetSnapshot, fileSha } from "./nightlySnapshot";
import { atomicJson, readJson } from "./nightlyStore";
import { SelfPlayStore } from "./selfPlayStore";
import { inspectDataStore } from "./selfPlayInspect";
import { sameData } from "./selfPlayData";
import { createInferenceFixture } from "./inferenceFixture";

if (import.meta.main) {
  const [command, configPath, report] = process.argv.slice(2);
  if (!report) throw new Error("nightlyStep command config report");
  const config = readJson<{ sources: string[]; destination: string; excludedSeeds: number[] }>(
    configPath,
  );
  if (command === "snapshot") {
    if (existsSync(config.destination)) {
      const meta = readJson<any>(join(config.destination, "manifest.json"));
      if (
        meta.source.manifest.format !== "four-shogi-dataset-snapshot-v1" ||
        fileSha(join(config.destination, "samples.jsonl")) !== meta.samples.sha256 ||
        Buffer.byteLength(readFileSync(join(config.destination, "samples.jsonl"))) !==
          meta.samples.bytes
      )
        throw new Error("既存snapshotが不完全です");
      const members = [];
      for (const source of config.sources) {
        const store = new SelfPlayStore(source, 1024 ** 4);
        try {
          const inspection = await inspectDataStore(store);
          members.push({ datasetId: inspection.datasetId, contentHash: inspection.contentHash });
        } finally {
          store.close();
        }
      }
      if (
        !sameData(
          members,
          meta.source.manifest.members.map((m: any) => ({
            datasetId: m.datasetId,
            contentHash: m.contentHash,
          })),
        )
      )
        throw new Error("再開元snapshotの入力集合が不一致です");
      atomicJson(report, {
        datasetId: meta.source.manifest.datasetId,
        members: meta.source.manifest.members,
        quality: meta.source.inspection.quality,
        samples: meta.samples,
        manifestSha256: fileSha(join(config.destination, "manifest.json")),
      });
    } else
      atomicJson(
        report,
        await createDatasetSnapshot(config.sources, config.destination, config.excludedSeeds),
      );
  } else if (command === "fixture") {
    const fixture = await createInferenceFixture();
    atomicJson(report, fixture);
  } else throw new Error("未知のnightly工程です");
}
