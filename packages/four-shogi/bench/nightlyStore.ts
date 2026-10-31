import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  existsSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { lockDataset } from "./selfPlayStore";
import { dataHash, sameData } from "./selfPlayData";
import { fileSha } from "./nightlySnapshot";

export const defaultAiDirectory = () =>
  resolve(process.env.AI_DATA_DIR ?? join(homedir(), "tetraboard-ai"));
export function readJson<T>(path: string): T {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 ** 2)
    throw new Error("管理ファイルの容量/形式が不正です");
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
export function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp-" + crypto.randomUUID();
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const parent = openSync(dirname(path), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
export function immutableJson(path: string, value: unknown) {
  if (existsSync(path)) {
    if (!sameData(readJson(path), value)) throw new Error("不変manifestの上書きを拒否します");
    return;
  }
  atomicJson(path, value);
}
export type GenerationManifest = {
  format: "four-shogi-generation-v1";
  id: string;
  generation: number;
  state: "candidate" | "promoted";
  createdAt: string;
  parentId: string | null;
  parentCheckpointSha256: string | null;
  modelId: string | null;
  checkpointSha256: string | null;
  localModelFile: string | null;
  localModelSha256: string | null;
  checkpointDirectory: string | null;
  snapshotId: string | null;
  trainingSamples: number;
  validation: Record<string, unknown>;
  qualified: boolean;
};
export const g0: GenerationManifest = {
  format: "four-shogi-generation-v1",
  id: "g000",
  generation: 0,
  state: "promoted",
  createdAt: "2026-10-31T00:00:00.000Z",
  parentId: null,
  parentCheckpointSha256: null,
  modelId: null,
  checkpointSha256: null,
  localModelFile: null,
  localModelSha256: null,
  checkpointDirectory: null,
  snapshotId: null,
  trainingSamples: 0,
  validation: { description: "従来P0-5・未校正静的評価" },
  qualified: true,
};
export type GenerationEntry = GenerationManifest & { available: boolean; error: string | null };
function validateGeneration(raw: GenerationManifest) {
  if (
    raw.format !== g0.format ||
    !/^g\d{3,6}(?:-candidate-[a-zA-Z0-9-]+)?$/.test(raw.id) ||
    !Number.isSafeInteger(raw.generation) ||
    raw.generation < 0 ||
    !["candidate", "promoted"].includes(raw.state)
  )
    throw new Error("世代manifestの形式が不正です");
  if (
    raw.generation > 0 &&
    (!raw.modelId ||
      raw.modelId !== "four-shogi-tiny-policy-value-v1:" + raw.checkpointSha256 ||
      !/^[a-f0-9]{64}$/.test(raw.checkpointSha256 ?? "") ||
      !raw.localModelFile ||
      !raw.localModelSha256 ||
      fileSha(raw.localModelFile) !== raw.localModelSha256)
  )
    throw new Error("世代モデルのID/SHA/実体が不一致です");
  return raw;
}
export function listGenerations(directory = defaultAiDirectory()): GenerationEntry[] {
  const path = join(directory, "generations");
  if (!existsSync(path)) return [{ ...g0, available: true, error: null }];
  return [
    { ...g0, available: true, error: null },
    ...readdirSync(path)
      .filter((name) => /^g\d+-candidate-[a-zA-Z0-9-]+$/.test(name))
      .sort()
      .map((name) => {
        const item = readJson<GenerationManifest>(join(path, name, "generation.json"));
        try {
          validateGeneration(item);
          const promoted = existsSync(join(path, name, "promotion.json"));
          return {
            ...item,
            state: promoted ? ("promoted" as const) : item.state,
            available: true,
            error: null,
          };
        } catch (error) {
          return { ...item, available: false, error: String(error) };
        }
      }),
  ];
}
export function resolveGeneration(id: string, directory = defaultAiDirectory()) {
  const entry = listGenerations(directory).find((g) => g.id === id);
  if (!entry || !entry.available)
    throw new Error(entry?.error ?? "指定した学習世代が見つかりません");
  return entry;
}
export function currentGeneration(directory = defaultAiDirectory()) {
  const path = join(directory, "current.json");
  if (!existsSync(path)) return { ...g0, available: true, error: null };
  const ref = readJson<{ id: string; modelId: string; generationManifestSha256: string }>(path),
    entry = resolveGeneration(ref.id, directory);
  if (
    entry.state !== "promoted" ||
    entry.modelId !== ref.modelId ||
    fileSha(join(directory, "generations", entry.id, "generation.json")) !==
      ref.generationManifestSha256
  )
    throw new Error("現役世代の参照/昇格が不一致です");
  return entry;
}
export function initializeNightlyRoot(path: string) {
  const root = resolve(path);
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) throw new Error("nightly rootにsymlinkを使えません");
  const release = lockDataset(root);
  try {
    const marker = join(root, ".nightly-root");
    if (existsSync(marker)) {
      if (readFileSync(marker, "utf8") !== "four-shogi-nightly-v1\n")
        throw new Error("nightly保存先の版が不一致です");
    } else {
      if (readdirSync(root).some((n) => n !== ".generation-lock"))
        throw new Error("無関係な保存先を初期化できません");
      writeFileSync(marker, "four-shogi-nightly-v1\n", { flag: "wx", mode: 0o600 });
    }
    for (const name of ["datasets", "snapshots", "generations", "runs", "reports"])
      mkdirSync(join(root, name), { recursive: true });
    return { root, release };
  } catch (error) {
    release();
    throw error;
  }
}
export function registerGeneration(root: string, manifest: GenerationManifest) {
  validateGeneration(manifest);
  const path = join(root, "generations", manifest.id, "generation.json");
  immutableJson(path, manifest);
  return dataHash(manifest);
}
