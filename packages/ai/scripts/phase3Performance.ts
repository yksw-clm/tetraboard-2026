import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { processMetrics } from "./processMetrics";
import { sourceIdentity } from "./sourceIdentity";

const root = new URL("..", import.meta.url).pathname;
const identity = await sourceIdentity(root);
const registryPath = process.argv[2];
const registry = JSON.parse(
  await readFile(resolve(root, registryPath ?? "configs/profiles-v1.json"), "utf8"),
) as { profiles: { id: string }[] };
const registryHash = Bun.CryptoHasher.hash("sha256", JSON.stringify(registry), "hex");
const binaryHash = Bun.CryptoHasher.hash(
  "sha256",
  await Bun.file(resolve(root, "target/release/study")).arrayBuffer(),
  "hex",
);
const directory = resolve(
  root,
  `results/phase3/performance-${identity.source_hash.slice(0, 16)}-${registryHash.slice(0, 8)}`,
);
await mkdir(directory, { recursive: true });
const start = performance.now();
const summaries: Record<string, unknown>[] = [];
const resources = [];
let combined = "";
for (const profile of registry.profiles) {
  const log = resolve(directory, `${profile.id}.jsonl`);
  const before = performance.now();
  const child = Bun.spawn(
    [resolve(root, "target/release/study"), "performance", registryPath ?? "-", profile.id],
    { cwd: root, stdout: Bun.file(log), stderr: "inherit" },
  );
  const code = await child.exited;
  if (code !== 0) throw Error(`性能測定失敗: ${profile.id}: ${code}`);
  const text = await Bun.file(log).text();
  combined += text;
  const rows = text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const summary = rows.at(-1);
  if (summary.record_type !== "performance_summary" || summary.profile_id !== profile.id)
    throw Error("性能測定のsummaryが不正です");
  summaries.push(summary);
  resources.push({
    profile_id: profile.id,
    elapsed_ms: performance.now() - before,
    resource_usage: processMetrics(child.resourceUsage()),
  });
}
await writeFile(resolve(directory, "performance.jsonl"), combined);
const result = {
  ...identity,
  binary_hash: binaryHash,
  registry_hash: registryHash,
  registry,
  os: process.platform,
  arch: process.arch,
  bun: Bun.version,
  elapsed_ms: performance.now() - start,
  process_resources: resources,
  summaries,
  latency_gate_passed: registryPath
    ? null
    : summaries.some((row) => row.profile_id === "lv5-v1" && Number(row.p95_ms) <= 500),
};
await writeFile(resolve(directory, "summary.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ directory, ...result }, null, 2));
