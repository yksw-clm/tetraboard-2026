import { readdirSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataHash } from "./selfPlayData";
/** 過去の利用可能な記録からseedだけを収集する。棋譜を学習へ取り込む処理ではない。 */
export function historicalSeeds(directories: readonly string[]) {
  const found = new Set<number>();
  let files = 0;
  const add = (value: string) => {
    const n = Number(value);
    if (Number.isSafeInteger(n) && n >= 10000 && n <= 99999) found.add(n);
  };
  function visit(directory: string) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          !entry.name.startsWith(".") &&
          !entry.name.includes("python") &&
          !["node_modules", "__pycache__", "model", "checkpoint"].includes(entry.name)
        )
          visit(path);
      } else if (entry.isFile() && /\.(json|jsonl|md)$/.test(entry.name)) {
        const fd = openSync(path, "r"),
          buffer = Buffer.alloc(65536);
        let length;
        try {
          length = readSync(fd, buffer, 0, buffer.length, 0);
        } finally {
          closeSync(fd);
        }
        files++;
        const text = buffer.subarray(0, length).toString();
        for (const match of text.matchAll(
          /"(?:seed|seedBase|openingSeed|baseSeed|seed_base)"\s*:\s*(\d+)/g,
        ))
          add(match[1]);
        for (const match of text.matchAll(
          /"(?:seeds|trainSeeds|validationSeeds|screenSeeds|confirmSeeds)"\s*:\s*\[([\d,\s]+)\]/g,
        ))
          for (const value of match[1].split(",")) add(value);
        for (const match of text.matchAll(/\bseed\s*[=:]\s*(\d+)/g)) add(match[1]);
      }
    }
  }
  for (const directory of directories) visit(directory);
  const values = [...found].sort((a, b) => a - b);
  return {
    values,
    summary: {
      filesInspected: files,
      maxPrefixBytes: 65536,
      seeds: values.length,
      sha256: dataHash(values),
      scope:
        "available docs and local measurement JSON/JSONL/Markdown prefixes; incomplete historical records are not a formal holdout registry",
    },
  };
}
