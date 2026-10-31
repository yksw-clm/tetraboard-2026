import { join, resolve } from "node:path";
import { repoRoot, sourceIdentity } from "./baseline";
import { currentDataCode } from "./selfPlayRun";
import { dataObject, dataInteger, dataHash } from "./selfPlayData";
import { fileSha } from "./nightlySnapshot";
import { cpus, availableParallelism, totalmem, release } from "node:os";
export type NightlyConfig = {
  schemaVersion: 1;
  python: string;
  device: "auto" | "cpu" | "mps";
  maxRunMs: number;
  maxRssMb: number;
  hardRssMb: number;
  minFreeGiB: number;
  trainFamilies: number;
  validationFamilies: number;
  seats: 4 | 1;
  maxPlies: number;
  actorWork: number;
  teacherWork: number;
  teacherPositions: number;
  trainingSteps: number;
  replayNights: number;
  compare: boolean;
  comparisonMs: number;
  comparisonMaxPlies: number;
  engineering: boolean;
  policyOnly: boolean;
};
export function nightlyConfig(value: unknown = {}, smoke = false): NightlyConfig {
  const defaults: NightlyConfig = {
    schemaVersion: 1,
    python: process.env.AI_PYTHON ?? join(repoRoot, "training/four-shogi-ai/.venv/bin/python"),
    device: "auto",
    maxRunMs: 6 * 3600000,
    maxRssMb: 6144,
    hardRssMb: 7168,
    minFreeGiB: 10,
    trainFamilies: 2,
    validationFamilies: 1,
    seats: 4,
    maxPlies: 512,
    actorWork: 4096,
    teacherWork: 16000,
    teacherPositions: 24,
    trainingSteps: 1000,
    replayNights: 8,
    compare: true,
    comparisonMs: 5000,
    comparisonMaxPlies: 512,
    engineering: false,
    policyOnly: false,
  };
  if (smoke)
    Object.assign(defaults, {
      maxRunMs: 180000,
      trainFamilies: 1,
      validationFamilies: 1,
      seats: 1,
      maxPlies: 128,
      actorWork: 512,
      teacherWork: 1600,
      teacherPositions: 8,
      trainingSteps: 8,
      compare: false,
    });
  const raw = dataObject(value, Object.keys(defaults)),
    config = { ...defaults, ...raw } as NightlyConfig;
  if (
    config.schemaVersion !== 1 ||
    typeof config.python !== "string" ||
    !config.python ||
    !["auto", "cpu", "mps"].includes(config.device) ||
    ![1, 4].includes(config.seats) ||
    [config.compare, config.engineering, config.policyOnly].some((v) => typeof v !== "boolean")
  )
    throw new Error("nightly設定の形式が不正です");
  for (const [key, min, max] of [
    ["maxRunMs", 1000, 21600000],
    ["maxRssMb", 512, 6144],
    ["hardRssMb", 512, 8192],
    ["minFreeGiB", 1, 256],
    ["trainFamilies", 1, 32],
    ["validationFamilies", 1, 8],
    ["maxPlies", 1, 2000],
    ["actorWork", 128, 1000000],
    ["teacherWork", 128, 1000000],
    ["teacherPositions", 1, 64],
    ["trainingSteps", 1, 100000],
    ["replayNights", 1, 64],
    ["comparisonMs", 100, 10000],
    ["comparisonMaxPlies", 1, 2000],
  ] as const)
    dataInteger(config[key], min, max);
  if (config.hardRssMb < config.maxRssMb) throw new Error("hard RSSは管理目標以上が必要です");
  if (config.policyOnly && !config.engineering)
    throw new Error("Policyのみの学習はengineering実験だけです");
  config.python = resolve(config.python);
  return config;
}
export function nightlySource() {
  const training = Object.fromEntries(
    [
      "dataset.py",
      "model.py",
      "train.py",
      "checkpoint.py",
      "inference.py",
      "localExport.py",
      "deviceBenchmark.py",
      "nightlyExport.py",
      "requirements.txt",
    ].map((name) => [name, fileSha(join(repoRoot, "training/four-shogi-ai", name))]),
  );
  const code = currentDataCode();
  const identity = {
    packageFiles: Object.fromEntries(
      [
        "package.json",
        "bun.lock",
        "packages/four-shogi/package.json",
        "apps/four-shogi-study/package.json",
      ].map((path) => [path, fileSha(join(repoRoot, path))]),
    ),
    host: {
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: availableParallelism(),
      totalMemory: totalmem(),
      osRelease: release(),
    },
    sourceHash: code.sourceHash,
    runnerHash: code.runnerHash,
    runtime: code.runtime,
    training,
    studySearch: sourceIdentity(join(repoRoot, "apps/four-shogi-study/src/search")).sha256,
    studyDomain: sourceIdentity(join(repoRoot, "apps/four-shogi-study/src/domain")).sha256,
  };
  return { code, identity, fingerprint: dataHash(identity) };
}
