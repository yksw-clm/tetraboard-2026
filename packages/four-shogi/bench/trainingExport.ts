import {
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { restoreAnalysisPosition, analysisRuleProfileId } from "../src/analysis";
import { actionEncodingVersion, actionSpaceSize } from "../src/actionEncoding";
import {
  encodeModelFeatures,
  featureVersion,
  currentFeatureSize,
  historyFeatureSize,
  maxHistoryEntries,
} from "../src/modelFeatures";
import { SelfPlayStore } from "./selfPlayStore";
import { inspectDataStore } from "./selfPlayInspect";
import { dataHash, positionFamilyKey, gamePlans } from "./selfPlayData";
import { currentDataCode } from "./selfPlayRun";

export const trainingDataVersion = "four-shogi-learning-data-v1";
export async function exportTrainingData(
  source: string,
  destination: string,
  maxBytes = 256 * 1024 ** 2,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 3)
    throw new RangeError("出力容量は1byte〜1GiBです");
  const output = resolve(destination);
  if (output === resolve(source) || output.startsWith(resolve(source) + "/"))
    throw new Error("学習入力は生成datasetの外へ出力してください");
  if (!existsSync(join(source, "manifest.json")))
    throw new Error("生成datasetのmanifestがありません");
  const store = new SelfPlayStore(source, 1024 ** 4);
  let created = false;
  let fd: number | undefined;
  try {
    if (store.bytes() > 1024 ** 3) throw new Error("生成datasetは1GiB以下にしてください");
    const inspection = await inspectDataStore(store);
    const manifest = store.readManifest()!;
    mkdirSync(output);
    created = true;
    const path = join(output, "samples.jsonl");
    fd = openSync(path, "wx", 0o600);
    const hasher = new Bun.CryptoHasher("sha256");
    let bytes = 0,
      count = 0;
    const counts = { train: 0, validation: 0, calibration: 0, test: 0 };
    for (const id of store.gameIds().sort()) {
      const record = store.readGame(id)!;
      if (record.status === "in_progress") continue;
      for (const sample of record.samples) {
        if (sample.policyActionId === null && record.outcome === null) continue;
        const position = await restoreAnalysisPosition({
          ...record.replay,
          eventOffset: sample.eventOffset,
        });
        const row = {
          id: dataHash({ gameId: id, eventOffset: sample.eventOffset }),
          gameId: id,
          familyId: record.plan.familyId,
          split: record.plan.split,
          restricted: position.state.threePlayerAttackProhibited,
          stateHash: sample.stateHash,
          positionFamily: positionFamilyKey(position.state),
          status: record.status,
          features: encodeModelFeatures(position),
          legalActionIds: sample.legalActionIds,
          policyTarget: sample.policyActionId,
          valueTarget: record.outcome?.target.indexOf(1) ?? null,
        };
        const line = JSON.stringify(row) + "\n";
        const size = Buffer.byteLength(line);
        if (bytes + size > maxBytes) throw new Error("学習入力の容量上限を超えています");
        writeFileSync(fd, line);
        hasher.update(line);
        bytes += size;
        count++;
        counts[row.split]++;
      }
    }
    if (!count) throw new Error("採用できる教師局面がありません");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const metadata = {
      schemaVersion: 1,
      format: trainingDataVersion,
      ruleProfileId: analysisRuleProfileId,
      rulesVersion: 1,
      featureVersion,
      actionEncodingVersion,
      actionSpaceSize,
      currentFeatureSize,
      historyFeatureSize,
      maxHistoryEntries,
      valueOrder: ["south", "west", "north", "east", "noSoleWinner"],
      source: { manifest, inspection, plans: gamePlans(manifest) },
      exporter: currentDataCode(),
      samples: {
        file: "samples.jsonl",
        sha256: hasher.digest("hex"),
        bytes,
        count,
        splits: counts,
      },
    };
    const text = JSON.stringify(metadata, null, 2) + "\n";
    if (bytes + Buffer.byteLength(text) > maxBytes)
      throw new Error("manifestを含む出力容量上限を超えています");
    const temporary = join(output, ".manifest.tmp");
    const metaFd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(metaFd, text);
      fsyncSync(metaFd);
    } finally {
      closeSync(metaFd);
    }
    renameSync(temporary, join(output, "manifest.json"));
    const dirFd = openSync(output, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    return metadata;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created) rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    store.close();
  }
}
if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length < 2 || args.length > 3)
    throw new Error("training:export <生成dataset> <新規出力先> [最大bytes]");
  const result = await exportTrainingData(
    args[0],
    args[1],
    args[2] === undefined ? undefined : Number(args[2]),
  );
  process.stdout.write(JSON.stringify(result.samples, null, 2) + "\n");
}
