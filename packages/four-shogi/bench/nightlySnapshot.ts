import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exportTrainingData } from "./trainingExport";
import { dataHash, sameData, replayFamily, type DataStart, type DataSplit } from "./selfPlayData";

export const fileSha = (path: string) =>
  new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
export type QualitySummary = {
  games: number;
  finished: number;
  truncated: number;
  soleWinners: number;
  repetitions: number;
  seatWins: number[];
  policySamples: number;
  valueClasses: number[];
  splits: Record<string, { families: number; policy: number; values: number[] }>;
  duplicateRows: number;
  duplicatePositions: number;
  eligible: boolean;
  reasons: string[];
};
export function qualityGate(summary: Pick<QualitySummary, "splits">) {
  const reasons: string[] = [];
  for (const split of ["train", "validation"]) {
    const group = summary.splits[split];
    if (!group || group.families < (split === "train" ? 2 : 1))
      reasons.push(`${split}: 独立系列不足`);
    if (!group || group.policy < (split === "train" ? 64 : 16))
      reasons.push(`${split}: Policy教師不足`);
    if (!group || group.values.slice(0, 4).some((n) => n < (split === "train" ? 8 : 2)))
      reasons.push(`${split}: 各方向の単独勝ちValue教師不足`);
  }
  return { eligible: reasons.length === 0, reasons };
}
/** 旧datasetを変更せず、全再生検査→集合間の系列/回転局面検査→新しい不変入力へ確定。 */
export async function createDatasetSnapshot(
  datasets: readonly string[],
  destination: string,
  excludedSeeds: readonly number[] = [],
) {
  if (
    !datasets.length ||
    datasets.length > 128 ||
    new Set(datasets.map((p) => resolve(p))).size !== datasets.length
  )
    throw new Error("dataset集合の件数/重複が不正です");
  const output = resolve(destination),
    temporary = output + ".preparing-" + crypto.randomUUID();
  if (existsSync(output)) throw new Error("snapshotは不変です。別の出力先を使用してください");
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(temporary);
  try {
    const exports = [];
    for (const [i, dataset] of datasets.entries())
      exports.push(
        await exportTrainingData(dataset, join(temporary, `source-${i}`), 512 * 1024 ** 2),
      );
    const starts = exports.flatMap((meta) => meta.source.manifest.starts);
    if (starts.some((s) => excludedSeeds.includes(s.seed)))
      throw new Error("棋力比較の予約系列を学習へ使用できません");
    if (starts.some((s) => s.split === "test" || s.split === "calibration"))
      throw new Error("日常snapshotはtrain/validationだけを使用します");
    const prefixes = new Map<number, Map<string, DataStart>>();
    for (const start of starts) {
      const n = start.replay.events.length;
      if (!n) continue;
      if (!prefixes.has(n)) prefixes.set(n, new Map());
      const key = replayFamily(start.replay),
        previous = prefixes.get(n)!.get(key);
      if (previous && previous.split !== start.split)
        throw new Error("回転した元系列がsplitを横断しています");
      prefixes.get(n)!.set(key, start);
    }
    for (const start of starts)
      for (const [length, registry] of prefixes) {
        if (length > start.replay.events.length) continue;
        const prior = registry.get(
          replayFamily({ ...start.replay, events: start.replay.events.slice(0, length) }),
        );
        if (prior && prior.split !== start.split)
          throw new Error("途中棋譜の系列がsplitを横断しています");
      }
    const members = exports.map((meta) => ({
      datasetId: meta.source.manifest.datasetId,
      contentHash: meta.source.inspection.contentHash,
      samplesSha256: meta.samples.sha256,
    }));
    if (new Set(members.map((m) => m.datasetId)).size !== members.length)
      throw new Error("同じdatasetを二重登録できません");
    const datasetId = dataHash({ format: "four-shogi-dataset-snapshot-v1", members });
    const quality: QualitySummary = {
      games: 0,
      finished: 0,
      truncated: 0,
      soleWinners: 0,
      repetitions: 0,
      seatWins: [0, 0, 0, 0],
      policySamples: 0,
      valueClasses: [0, 0, 0, 0, 0],
      splits: {},
      duplicateRows: 0,
      duplicatePositions: 0,
      eligible: false,
      reasons: [],
    };
    const rows: string[] = [],
      ids = new Map<string, string>(),
      families = new Map<string, DataSplit>(),
      positions = new Map<string, DataSplit>(),
      counts = { train: 0, validation: 0, calibration: 0, test: 0 };
    const splitFamilies = new Map<string, Set<string>>(),
      plans = new Map<string, unknown>();
    for (const [i, meta] of exports.entries()) {
      const baseline = exports[0];
      for (const key of [
        "format",
        "ruleProfileId",
        "rulesVersion",
        "featureVersion",
        "actionEncodingVersion",
        "currentFeatureSize",
        "historyFeatureSize",
        "valueOrder",
      ] as const)
        if (!sameData(meta[key], baseline[key]))
          throw new Error("datasetの特徴/ルール版が不一致です");
      quality.games += meta.source.inspection.finished + meta.source.inspection.truncated;
      quality.finished += meta.source.inspection.finished;
      quality.truncated += meta.source.inspection.truncated;
      for (const plan of meta.source.plans) {
        if (plans.has(plan.gameId) && !sameData(plans.get(plan.gameId), plan))
          throw new Error("ゲーム識別が衝突しました");
        plans.set(plan.gameId, plan);
      }
      // 生の正本結果から局単位の分布を数え、sample数と区別する。
      const { SelfPlayStore } = await import("./selfPlayStore");
      const store = new SelfPlayStore(datasets[i], 1024 ** 4);
      try {
        for (const id of store.gameIds()) {
          const game = store.readGame(id)!;
          if (game.outcome) {
            if (game.outcome.winner) {
              quality.soleWinners++;
              quality.seatWins[["south", "west", "north", "east"].indexOf(game.outcome.winner)]++;
            }
            if (
              game.outcome.result?.mode === "singles" &&
              game.outcome.result.reason === "repetition"
            )
              quality.repetitions++;
          }
        }
      } finally {
        store.close();
      }
      const lines = readFileSync(join(temporary, `source-${i}`, "samples.jsonl"), "utf8")
        .trim()
        .split("\n");
      for (const line of lines) {
        const row = JSON.parse(line),
          split = row.split as DataSplit;
        if (ids.has(row.id)) {
          if (ids.get(row.id) !== line) throw new Error("同じ教師IDに異なる内容があります");
          quality.duplicateRows++;
          continue;
        }
        for (const [registry, key] of [
          [families, row.familyId],
          [positions, row.positionFamily],
        ] as const) {
          if (registry.has(key) && registry.get(key) !== split)
            throw new Error("集合間で系列/回転局面がsplitを横断しています");
          if (registry === positions && registry.has(key)) quality.duplicatePositions++;
          registry.set(key, split);
        }
        ids.set(row.id, line);
        rows.push(line);
        counts[split]++;
        if (rows.length > 100000) throw new Error("snapshotは100000局面までです");
        const group = (quality.splits[split] ??= {
          families: 0,
          policy: 0,
          values: [0, 0, 0, 0, 0],
        });
        if (!splitFamilies.has(split)) splitFamilies.set(split, new Set());
        splitFamilies.get(split)!.add(row.familyId);
        if (row.policyTarget !== null) {
          quality.policySamples++;
          group.policy++;
        }
        if (row.valueTarget !== null) {
          quality.valueClasses[row.valueTarget]++;
          group.values[row.valueTarget]++;
        }
      }
    }
    for (const [split, set] of splitFamilies) quality.splits[split].families = set.size;
    Object.assign(quality, qualityGate(quality));
    const content = rows.join("\n") + "\n";
    if (Buffer.byteLength(content) > 512 * 1024 ** 2) throw new Error("snapshotの容量上限です");
    writeFileSync(join(temporary, "samples.jsonl"), content, { flag: "wx", mode: 0o600 });
    const metadata = {
      ...exports[0],
      source: {
        manifest: { datasetId, format: "four-shogi-dataset-snapshot-v1", members },
        inspection: { datasetId, quality },
        plans: [...plans.values()],
      },
      samples: {
        file: "samples.jsonl",
        sha256: fileSha(join(temporary, "samples.jsonl")),
        bytes: Buffer.byteLength(content),
        count: rows.length,
        splits: counts,
      },
    };
    writeFileSync(join(temporary, "manifest.json"), JSON.stringify(metadata, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    for (const name of ["samples.jsonl", "manifest.json"]) {
      const fd = openSync(join(temporary, name), "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    renameSync(temporary, output);
    const fd = openSync(dirname(output), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return {
      datasetId,
      members,
      quality,
      samples: metadata.samples,
      manifestSha256: fileSha(join(output, "manifest.json")),
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
