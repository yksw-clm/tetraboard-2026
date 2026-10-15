import {
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  symlinkSync,
  readlinkSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { dataHash, type DataManifest, type GameArtifact } from "./selfPlayData";
import { GenerationPaused } from "./selfPlayGame";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
function owner(path: string) {
  const target = readlinkSync(path);
  const match = /^(\d+):[0-9a-f-]+$/.exec(target);
  if (!match) throw new Error("生成ロックの所有者を確認できません");
  return { target, pid: Number(match[1]) };
}
export function lockDataset(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, ".generation-lock");
  const recovery = join(directory, ".recovery-lock");
  const token = `${process.pid}:${crypto.randomUUID()}`;
  if (
    existsSync(recovery) ||
    (() => {
      try {
        readlinkSync(recovery);
        return true;
      } catch {
        return false;
      }
    })()
  )
    throw new Error("datasetのロック回復中です。回復プロセス終了後に再実行してください");
  try {
    symlinkSync(token, lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (alive(owner(lock).pid)) throw new Error("このdatasetは別の生成/検査プロセスが使用中です");
    // 回復者を一人に制限し、生存中の所有者や並行して取得されたロックを削除しません。
    symlinkSync(token, recovery);
    try {
      if (alive(owner(lock).pid)) throw new Error("datasetの所有者が変わりました");
      unlinkSync(lock);
      symlinkSync(token, lock);
    } finally {
      if (owner(recovery).target === token) unlinkSync(recovery);
    }
  }
  return () => {
    if (owner(lock).target !== token) throw new Error("datasetロックの所有者が不一致です");
    unlinkSync(lock);
  };
}

/** 親プロセスだけが保存し、旧ファイルと一時ファイルを含む論理byte量を制限します。 */
export class SelfPlayStore {
  readonly directory: string;
  readonly scratchDirectory: string;
  private readonly release: () => void;
  constructor(
    directory: string,
    readonly maxBytes: number,
  ) {
    this.directory = resolve(directory);
    this.scratchDirectory = join(this.directory, ".scratch");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("容量上限が必要です");
    this.release = lockDataset(this.directory);
    try {
      const marker = join(this.directory, ".selfplay-store");
      const format = "four-shogi-selfplay-store-v1\n";
      const entries = readdirSync(this.directory);
      if (!existsSync(marker)) {
        if (entries.some((name) => name !== ".generation-lock"))
          throw new Error("既存ファイルがある保存先は初期化できません");
        writeFileSync(marker, format, { flag: "wx", mode: 0o600 });
      } else if (
        !lstatSync(marker).isFile() ||
        lstatSync(marker).isSymbolicLink() ||
        readFileSync(marker, "utf8") !== format
      )
        throw new Error("datasetの所有マーカーが不正です");
      for (const name of entries) {
        if (
          name !== ".scratch" &&
          name !== ".generation-lock" &&
          name !== ".selfplay-store" &&
          name !== "manifest.json" &&
          !/^[0-9a-f]{64}\.json$/.test(name) &&
          !/^\.tmp-[0-9a-f-]+$/.test(name)
        )
          throw new Error(`dataset出力先に無関係なファイルがあります: ${name}`);
      }
      for (const name of entries) {
        if (name === ".scratch") {
          const stat = lstatSync(this.scratchDirectory);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error("一時ソースの保存先が不正です");
          rmSync(this.scratchDirectory, { recursive: true });
        } else if (/^\.tmp-[0-9a-f-]+$/.test(name)) {
          const path = join(this.directory, name);
          if (!lstatSync(path).isFile()) throw new Error("一時保存に通常ファイル以外があります");
          unlinkSync(path);
        } else if (
          name !== ".generation-lock" &&
          name !== ".selfplay-store" &&
          name !== "manifest.json" &&
          !/^[0-9a-f]{64}\.json$/.test(name)
        )
          throw new Error(`dataset出力先に無関係なファイルがあります: ${name}`);
      }
      mkdirSync(this.scratchDirectory);
    } catch (error) {
      this.release();
      throw error;
    }
  }
  close() {
    try {
      rmSync(this.scratchDirectory, { recursive: true, force: true });
    } finally {
      this.release();
    }
  }
  bytes() {
    return readdirSync(this.directory).reduce((sum, name) => {
      if (name.startsWith(".")) return sum;
      const stat = lstatSync(join(this.directory, name));
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("datasetは通常ファイルに限定します");
      return sum + stat.size;
    }, 0);
  }
  private read<T>(name: string): T | null {
    const path = join(this.directory, name);
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes)
      throw new Error("保存データの形式/容量が不正です");
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    if (
      !envelope ||
      Object.keys(envelope).sort().join(",") !== "checksum,payload" ||
      dataHash(envelope.payload) !== envelope.checksum
    )
      throw new Error(`保存データのchecksumが不一致です: ${name}`);
    return envelope.payload as T;
  }
  private write(name: string, payload: unknown) {
    const path = join(this.directory, name);
    if (existsSync(path) && !lstatSync(path).isFile())
      throw new Error("保存先が通常ファイルではありません");
    const serialized = JSON.stringify({ checksum: dataHash(payload), payload }) + "\n";
    const bytes = Buffer.byteLength(serialized);
    if (this.bytes() + bytes > this.maxBytes) throw new GenerationPaused("byte_limit");
    const temporary = join(this.directory, `.tmp-${crypto.randomUUID()}`);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, serialized);
      fsyncSync(descriptor);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, path);
      const directory = openSync(this.directory, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  readManifest() {
    return this.read<DataManifest>("manifest.json");
  }
  writeManifest(manifest: DataManifest) {
    if (this.readManifest()) throw new Error("manifestの上書きはできません");
    this.write("manifest.json", manifest);
  }
  readGame(id: string) {
    this.requireId(id);
    return this.read<GameArtifact>(`${id}.json`);
  }
  writeGame(record: GameArtifact) {
    this.requireId(record.plan.gameId);
    this.write(`${record.plan.gameId}.json`, record);
  }
  gameIds() {
    return readdirSync(this.directory)
      .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
      .map((name) => name.slice(0, -5));
  }
  private requireId(id: string) {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new TypeError("ゲームIDが不正です");
  }
}
