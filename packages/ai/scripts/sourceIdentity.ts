import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function sourceIdentity(root: string, additionalFiles: string[] = []) {
  const names = [
    ...new Bun.Glob("crates/**/*.{rs,toml}").scanSync({ cwd: root }),
    "Cargo.toml",
    "Cargo.lock",
    "configs/profiles-v1.json",
    ...additionalFiles,
  ].sort();
  const files: Record<string, string> = {};
  for (const name of names)
    files[name] = Bun.CryptoHasher.hash("sha256", await readFile(resolve(root, name)), "hex");
  return { source_hash: Bun.CryptoHasher.hash("sha256", JSON.stringify(files), "hex"), files };
}
