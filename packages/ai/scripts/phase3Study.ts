import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { processMetrics } from "./processMetrics";
import { sourceIdentity } from "./sourceIdentity";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const rounds = Number(args[0] ?? 4);
const baseSeed = Number(args[1] ?? 0);
if (!Number.isSafeInteger(rounds) || rounds < 1 || !Number.isSafeInteger(baseSeed) || baseSeed < 0)
  throw Error("rounds・seedが不正です");
const reference = JSON.parse(await readFile(resolve(root, "configs/phase1.json"), "utf8")) as {
  profiles: { id: string; config: Record<string, unknown> }[];
};
const binary = resolve(root, "target/release/tetraboard-ai-benchmark");
const binaryHash = Bun.CryptoHasher.hash("sha256", await Bun.file(binary).arrayBuffer(), "hex");
const identity = await sourceIdentity(root);
const out = resolve(
  root,
  `results/phase3-tuning/grid-${identity.source_hash.slice(0, 16)}-${binaryHash.slice(0, 8)}`,
);
await mkdir(out, { recursive: true });
const source = await Bun.$`git -C ${root} rev-parse HEAD`.text();
const snapshot = resolve(out, "benchmark");
if (!(await Bun.file(snapshot).exists())) {
  await copyFile(binary, snapshot);
  await chmod(snapshot, 0o755);
}
await writeFile(
  resolve(out, "manifest.json"),
  JSON.stringify(
    {
      ...identity,
      binary_hash: binaryHash,
      source_commit: source.trim(),
      rounds,
      seed: baseSeed,
      jobs: 4,
    },
    null,
    2,
  ) + "\n",
);
const weights = reference.profiles[1]!.config.weights;
for (const rollout of ["uniform", "epsilon_greedy"])
  for (const iterations of [32, 128, 512])
    for (const coefficient of [500, 1000, 1414]) {
      const name = `${rollout}-${iterations}-${coefficient}-seed${baseSeed}-rounds${rounds}`;
      const config = {
        format_version: 2,
        seed: baseSeed,
        profiles: [
          ...reference.profiles,
          {
            id: "candidate",
            config: {
              agent_id: "four-reversi-mcts-v1",
              seed: 0,
              weights,
              rollout,
              exploration_milli: coefficient,
              budget: { max_iterations: iterations, max_nodes: 65536 },
            },
          },
        ],
        matchups: [
          { id: "vs-greedy", lineup: ["candidate", "lv2", "lv2", "lv2"] },
          { id: "vs-maxn", lineup: ["candidate", "lv3", "lv3", "lv3"] },
          { id: "mixed", lineup: ["candidate", "lv3", "lv2", "lv1"] },
        ],
      };
      const configFile = resolve(out, `${name}.json`);
      const logFile = resolve(out, `${name}.jsonl`);
      const resultFile = resolve(out, `${name}.summary.json`);
      if (await Bun.file(resultFile).exists()) {
        console.log(`reuse ${name}`);
        continue;
      }
      await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");
      const start = performance.now();
      const child = Bun.spawn(
        [
          snapshot,
          "--config",
          configFile,
          "--rounds",
          String(rounds),
          "--seed",
          String(baseSeed),
          "--jobs",
          "4",
        ],
        { cwd: root, stdout: Bun.file(logFile), stderr: "inherit" },
      );
      const exit = await child.exited;
      if (exit !== 0) throw Error(`比較失敗 ${name}: ${exit}`);
      const lines = (await readFile(logFile, "utf8")).trimEnd().split("\n");
      const summary = JSON.parse(lines.at(-1)!);
      const result = {
        name,
        source_commit: source.trim(),
        source_hash: identity.source_hash,
        binary_hash: binaryHash,
        elapsed_ms: performance.now() - start,
        resource_usage: processMetrics(child.resourceUsage()),
        config,
        summary,
      };
      await writeFile(resultFile, JSON.stringify(result, null, 2) + "\n");
      console.log(
        JSON.stringify({
          name,
          elapsed_ms: result.elapsed_ms,
          statistics: summary.statistics.filter(
            (v: { profile_id: string; color: unknown }) =>
              v.profile_id === "candidate" && v.color === null,
          ),
        }),
      );
    }
