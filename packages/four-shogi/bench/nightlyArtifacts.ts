import { readdirSync, lstatSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileSha } from "./nightlySnapshot";
import { atomicJson } from "./nightlyStore";
export function saveNightlyArtifacts(
  root: string,
  directories: readonly string[],
  destination: string,
  source: { commit: string; fingerprint: string },
  maxHashBytes = 512 * 1024 ** 2,
) {
  const files = new Map<string, number>();
  function visit(path: string) {
    if (!existsSync(path) || resolve(path) === resolve(destination)) return;
    const s = lstatSync(path);
    if (s.isSymbolicLink()) return;
    if (s.isDirectory()) {
      for (const name of readdirSync(path))
        if (
          !name.includes(".tmp") &&
          !name.includes(".preparing-") &&
          ![".scratch", ".lock", ".generation-lock", ".recovery-lock"].includes(name)
        )
          visit(join(path, name));
    } else if (s.isFile()) files.set(resolve(path), s.size);
  }
  for (const directory of directories) visit(directory);
  let hashedBytes = 0,
    hashedFiles = 0;
  const priority = (path: string) =>
    /manifest\.json$|generation\.json$|plan\.json$|\.f32$|\.pt$|summary\.(md|json)$/.test(path)
      ? 0
      : 1;
  const rows = [...files]
    .sort(([a], [b]) => priority(a) - priority(b) || a.localeCompare(b))
    .map(([path, bytes]) => {
      const verify = hashedBytes + bytes <= maxHashBytes;
      if (verify) {
        hashedBytes += bytes;
        hashedFiles++;
      }
      return {
        path: relative(root, path),
        bytes,
        sha256: verify ? fileSha(path) : null,
        verification: verify
          ? "full bytes SHA-256"
          : "size only: final hashing budget reached; dataset/checkpoint native checksums remain in their manifests",
      };
    });
  const manifest = {
    format: "four-shogi-nightly-artifacts-v1",
    source,
    files: rows,
    totalFiles: rows.length,
    totalBytes: [...files.values()].reduce((a, b) => a + b, 0),
    hashedFiles,
    hashedBytes,
    maxHashBytes,
  };
  atomicJson(destination, manifest);
  return manifest;
}
