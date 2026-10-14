import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { SearchOptions, SearchStats } from "../src/cpuSearch";
import type { FourShogiState, FourShogiAction } from "../src/types";
import type { MeasuredSelector } from "./singlesMeasurement";
import { hashJson } from "./singlesMeasurement";
import manifest from "./lv2Baseline.json";

export const repoRoot = join(import.meta.dir, "../../..");
export function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}に失敗: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
export function sourceIdentity(directory: string) {
  const files: { path: string; sha256: string }[] = [];
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile())
        files.push({
          path: relative(directory, full).replaceAll("\\", "/"),
          sha256: new Bun.CryptoHasher("sha256").update(readFileSync(full)).digest("hex"),
        });
      else throw new Error(`ソースに通常ファイル以外が存在します: ${full}`);
    }
  }
  visit(directory);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { sha256: hashJson(files), files };
}

type CpuModule = {
  chooseCpuAction: (state: FourShogiState, level: 2) => FourShogiAction | null;
  chooseCpuActionWithDiagnostics?: (
    state: FourShogiState,
    options?: SearchOptions,
  ) => { action: FourShogiAction | null; stats: SearchStats };
};
export type Player = {
  id: string;
  selector: MeasuredSelector;
  metadata: {
    selector: string;
    commit: string;
    source: ReturnType<typeof sourceIdentity>;
    searchOptions: SearchOptions | null;
    modelId: null;
    configurationOrigin: string;
  };
  dispose: () => void;
};

export async function loadPlayer(name: string, options: SearchOptions = {}): Promise<Player> {
  const frozen = name === "frozen";
  const legacy = name === "legacy";
  const live = name === "current";
  if (!frozen && !legacy && !live && !/^commit:[0-9a-f]{40}$/.test(name))
    throw new Error(`不正なAI指定: ${name}`);
  if (frozen || legacy) {
    if (Object.keys(options).length) throw new Error("固定基準の探索設定は変更できません");
  }
  const commit = live
    ? git("rev-parse", "HEAD")
    : frozen
      ? manifest.commit
      : legacy
        ? manifest.legacyCommit
        : name.slice(7);
  let directory: string | null = null;
  try {
    let src = join(repoRoot, "packages/four-shogi/src");
    if (!live) {
      directory = mkdtempSync(join(tmpdir(), "tetraboard-lv2-"));
      const archive = Bun.spawnSync(["git", "archive", commit, "packages/four-shogi/src"], {
        cwd: repoRoot,
      });
      if (archive.exitCode !== 0) throw new Error(`固定コミットが見つかりません: ${commit}`);
      const extracted = Bun.spawnSync(["tar", "-xf", "-", "-C", directory], {
        stdin: archive.stdout,
      });
      if (extracted.exitCode !== 0) throw new Error("固定ソースを展開できません");
      src = join(directory, "packages/four-shogi/src");
    }
    const source = sourceIdentity(src);
    if (frozen && source.sha256 !== manifest.source.sha256)
      throw new Error("現行Lv2基準のソースハッシュが一致しません");
    if (legacy && source.sha256 !== manifest.legacySourceSha256)
      throw new Error("旧Lv2基準のソースハッシュが一致しません");
    const module: CpuModule = await import(pathToFileURL(join(src, "cpu.ts")).href);
    const searchOptions = frozen
      ? manifest.searchOptions
      : legacy
        ? null
        : source.sha256 === manifest.source.sha256
          ? {
              ...manifest.searchOptions,
              ...options,
              evaluationWeights: {
                ...manifest.searchOptions.evaluationWeights,
                ...options.evaluationWeights,
              },
            }
          : options;
    const metadata = {
      selector: name,
      commit,
      source,
      searchOptions,
      modelId: null,
      configurationOrigin: frozen
        ? "fixed-manifest"
        : legacy
          ? "fixed-legacy-source"
          : "overrides-and-versioned-source-defaults",
    };
    const id = `${name}/${hashJson(metadata).slice(0, 16)}`;
    const selector: MeasuredSelector = (state) => {
      if (module.chooseCpuActionWithDiagnostics)
        return module.chooseCpuActionWithDiagnostics(
          state,
          frozen ? undefined : (searchOptions ?? undefined),
        );
      if (Object.keys(options).length)
        throw new Error("この歴代版は探索設定の上書きに対応していません");
      return { action: module.chooseCpuAction(state, 2), stats: null };
    };
    return {
      id,
      metadata,
      selector,
      dispose: () => {
        if (directory) rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
