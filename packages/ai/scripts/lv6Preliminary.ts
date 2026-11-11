import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { cpus, release, totalmem } from "node:os";
import { resolve } from "node:path";
import builtin from "../configs/profiles-v1.json";
import candidates from "../configs/local-analysis-profiles-v1.json";
import { processMetrics } from "./processMetrics";
import { sourceIdentity } from "./sourceIdentity";
import { focalStatistics, type PreliminaryGame } from "./lv6Statistics";

// 本評価を開始する経路は設けず、独立した予備seedだけを測ります。
if (process.argv.length > 2) throw Error("予備測定は引数なし・2 seed・24局に固定しています");
const root = new URL("..", import.meta.url).pathname;
const candidateId = "lv6-candidate-a-v1",
  baselineId = "lv5-v1";
const seeds = [6_000_000, 6_000_001];
const opponents = [
  ["lv1-v1", "lv2-v1"],
  ["lv3-v1", "lv3-v1"],
  ["lv4-v1", "lv5-v1"],
];
const profiles = [...builtin.profiles, ...candidates.profiles].map((p) => {
  const config = structuredClone(p.config);
  if (p.id === baselineId && config.budget) Object.assign(config.budget, { max_time_ms: 2000 });
  return { ...p, config };
});
const config = {
  format_version: 2,
  seed: 0,
  seat_orders: "cyclic",
  profiles: profiles.map(({ id, config }) => ({ id, config })),
  matchups: opponents.map((rest, i) => ({
    id: `lv6-vs-lv5-${i}`,
    lineup: [candidateId, baselineId, ...rest],
  })),
};
const identity = await sourceIdentity(root, [
  "configs/local-analysis-profiles-v1.json",
  "scripts/lv6Preliminary.ts",
  "scripts/lv6Statistics.ts",
  "scripts/sourceIdentity.ts",
  "scripts/processMetrics.ts",
]);
const binary = resolve(root, "target/release/tetraboard-ai-benchmark");
const binaryHash = Bun.CryptoHasher.hash("sha256", await Bun.file(binary).arrayBuffer(), "hex");
const directory = resolve(
  root,
  `results/local-analysis/preliminary-${Date.now()}-${binaryHash.slice(0, 8)}`,
);
await mkdir(directory, { recursive: true });
const snapshot = resolve(directory, "benchmark");
await copyFile(binary, snapshot);
await chmod(snapshot, 0o755);
const configFile = resolve(directory, "config.json");
await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");
const manifest = {
  ...identity,
  binary_hash: binaryHash,
  source_commit: (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim(),
  source_dirty: !!(await Bun.$`git -C ${root} status --porcelain`.text()).trim(),
  environment: {
    os: process.platform,
    release: release(),
    arch: process.arch,
    cpu: cpus()[0]?.model,
    logical_cpus: cpus().length,
    total_memory_bytes: totalmem(),
    bun: Bun.version,
  },
  started_at: new Date().toISOString(),
  jobs: 1,
  seeds,
  seat_orders: "cyclic",
  planned_games: 24,
  max_wall_time_ms: 30 * 60 * 1000,
  profiles,
  config,
  usage: "preliminary-only; never adoption evidence",
  reproducible: false,
  main_evaluation: {
    games: 2304,
    seed_start: 7_000_000,
    seeds: 32,
    seat_orders: "all_permutations",
    jobs: 1,
  },
};
await writeFile(resolve(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ directory, planned_games: 24, jobs: 1 }));
const records: PreliminaryGame[] = [];
const runs = [];
let active: Bun.Subprocess | undefined;
let stopping = false;
const stop = () => {
  stopping = true;
  active?.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const started = performance.now();
try {
  for (const seed of seeds) {
    if (stopping) throw Error("予備測定を中断しました");
    const partial = resolve(directory, `seed-${seed}.jsonl.partial`);
    const before = performance.now();
    const child = (active = Bun.spawn(
      [snapshot, "--config", configFile, "--rounds", "1", "--seed", String(seed), "--jobs", "1"],
      { cwd: root, stdout: Bun.file(partial), stderr: "inherit" },
    ));
    const timeout = setTimeout(
      () => child.kill("SIGTERM"),
      Math.max(1, manifest.max_wall_time_ms - (before - started)),
    );
    let code: number;
    try {
      code = await child.exited;
    } finally {
      clearTimeout(timeout);
      active = undefined;
    }
    const run = {
      seed,
      exit: code,
      elapsed_ms: performance.now() - before,
      resource_usage: processMetrics(child.resourceUsage()),
    };
    runs.push(run);
    if (code !== 0) throw Error(`予備測定を中断しました: seed ${seed}, exit ${code}`);
    const lines = (await readFile(partial, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const summary = lines.pop();
    if (
      summary?.record_type !== "summary" ||
      summary.completed_games !== 12 ||
      summary.failed_games !== 0 ||
      lines.length !== 12 ||
      lines.some((r) => r.record_type !== "game" || !r.game || r.error)
    )
      throw Error("未完了・失敗を含む予備測定です");
    records.push(...lines);
    await rename(partial, partial.replace(/\.partial$/, ""));
    await writeFile(
      resolve(directory, `seed-${seed}.done.json`),
      JSON.stringify(run, null, 2) + "\n",
    );
    console.log(JSON.stringify({ ...run, completed_games: records.length }));
  }

  const elapsed = performance.now() - started;
  const matchups = config.matchups.map((m) => {
    const rows = records.filter((r) => r.matchup_id === m.id);
    return {
      id: m.id,
      opponents: m.lineup.slice(2),
      games: rows.length,
      candidate: focalStatistics(rows, 0),
      baseline: focalStatistics(rows, 1),
      mean_game_ms: rows.reduce((s, r) => s + r.game!.total_time_ns / 1e6, 0) / rows.length,
    };
  });
  const estimate = (elapsed / records.length) * manifest.main_evaluation.games;
  const result = {
    status: "completed",
    adoption: "pending",
    completed_games: records.length,
    failed_games: 0,
    elapsed_ms: elapsed,
    candidate: focalStatistics(records, 0),
    baseline: focalStatistics(records, 1),
    matchups,
    runs,
    main_evaluation_estimate_ms: estimate,
    planning_budget_ms: estimate * 1.3,
    estimate_note:
      "予備4回転から全24席順への外挿。30%の余裕は計画用で信頼区間ではありません。ビルド・本評価集計時間は含みません。",
  };
  await writeFile(resolve(directory, "summary.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ directory, ...result }, null, 2));
} catch (error) {
  await writeFile(
    resolve(directory, "failed.json"),
    JSON.stringify(
      {
        status: "failed",
        adoption: "pending",
        elapsed_ms: performance.now() - started,
        runs,
        error: String(error),
      },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
