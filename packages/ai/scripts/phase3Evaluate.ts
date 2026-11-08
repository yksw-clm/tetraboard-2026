import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { processMetrics } from "./processMetrics";
import { sourceIdentity } from "./sourceIdentity";

const root = new URL("..", import.meta.url).pathname;
const phase = process.argv[2] ?? "train";
const attempt = Number(process.argv[3] ?? 1);
const rounds = Number(process.argv[4] ?? (phase === "train" ? 16 : 32));
if (
  !["train", "confirm"].includes(phase) ||
  !Number.isSafeInteger(attempt) ||
  attempt < 1 ||
  !Number.isSafeInteger(rounds) ||
  rounds < 1 ||
  rounds > 32
)
  throw Error("train/confirm・attempt・roundsが不正です");
const registry = JSON.parse(
  await readFile(resolve(root, process.argv[5] ?? "configs/profiles-v1.json"), "utf8"),
) as {
  profiles: { id: string; config: unknown; profile_hash: string }[];
};
const binary = resolve(root, "target/release/tetraboard-ai-benchmark");
const binaryHash = Bun.CryptoHasher.hash("sha256", await Bun.file(binary).arrayBuffer(), "hex");
const key = Bun.CryptoHasher.hash(
  "sha256",
  JSON.stringify({ phase, attempt, rounds, registry, binaryHash }),
  "hex",
);
const out = resolve(root, `results/phase3/${phase}-${attempt}-${key.slice(0, 16)}`);
await mkdir(out, { recursive: true });
const snapshot = resolve(out, "benchmark");
if (!(await Bun.file(snapshot).exists())) {
  await copyFile(binary, snapshot);
  await chmod(snapshot, 0o755);
}
const manifest = {
  ...(await sourceIdentity(root)),
  phase,
  attempt,
  rounds,
  binary_hash: binaryHash,
  profiles: registry.profiles,
  source_commit: (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim(),
  jobs: 4,
};
await writeFile(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ directory: out, ...manifest }));
for (const [candidate, baseline] of [
  ["lv4-v1", "lv3-v1"],
  ["lv5-v1", "lv4-v1"],
]) {
  const config = {
    format_version: 2,
    seed: 0,
    seat_orders: phase === "confirm" ? "all_permutations" : "cyclic",
    profiles: registry.profiles.map((p) => ({ id: p.id, config: p.config })),
    matchups: [
      ["lv1-v1", "lv2-v1"],
      ["lv2-v1", "lv3-v1"],
      ["lv3-v1", "lv3-v1"],
    ].map((opponents, index) => ({
      id: `${candidate}-vs-${baseline}-${index}`,
      lineup: [candidate, baseline, ...opponents],
    })),
  };
  const configFile = resolve(out, `${candidate}.json`);
  await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");
  for (let round = 0; round < rounds; round++) {
    const seed = phase === "train" ? round : 1_000_000 + 32 * (attempt - 1) + round;
    const name = `${candidate}-seed${seed}`;
    const final = resolve(out, `${name}.jsonl`);
    const done = resolve(out, `${name}.done.json`);
    if (await Bun.file(done).exists()) {
      console.log(`reuse ${name}`);
      continue;
    }
    const failed = resolve(out, `${name}.failed.json`);
    if (await Bun.file(failed).exists())
      throw Error(`失敗した試行は自動で再実行しません: ${failed}`);
    const start = performance.now();
    const child = Bun.spawn(
      [snapshot, "--config", configFile, "--rounds", "1", "--seed", String(seed), "--jobs", "4"],
      { cwd: root, stdout: Bun.file(final + ".partial"), stderr: "inherit" },
    );
    const code = await child.exited;
    const details = {
      seed,
      candidate,
      baseline,
      exit: code,
      elapsed_ms: performance.now() - start,
      resource_usage: processMetrics(child.resourceUsage()),
    };
    if (code !== 0) {
      await writeFile(failed, JSON.stringify(details, null, 2) + "\n");
      throw Error(`対局失敗 ${name}`);
    }
    const lines = (await readFile(final + ".partial", "utf8")).trimEnd().split("\n");
    const summary = JSON.parse(lines.at(-1)!);
    const expected = (phase === "confirm" ? 24 : 4) * 3;
    if (
      summary.record_type !== "summary" ||
      summary.failed_games !== 0 ||
      summary.completed_games !== expected ||
      lines.length !== expected + 1
    )
      throw Error(`棋譜が不完全です: ${name}`);
    await rename(final + ".partial", final);
    await writeFile(done, JSON.stringify(details, null, 2) + "\n");
    console.log(JSON.stringify(details));
  }
}
console.log(`completed ${out}`);
