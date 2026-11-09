import { appendFile, copyFile, mkdir, readFile, rename, rmdir } from "node:fs/promises";
import { availableParallelism, cpus, release } from "node:os";
import { join, resolve } from "node:path";
import profilesFile from "../configs/profiles-v1.json";
import charactersFile from "../configs/characters-v1.json";
import { sourceIdentity } from "./sourceIdentity";
import { readCalibrationUnit } from "./fourReversiCalibrationStatistics";

const [directoryArgument, preliminaryArgument] = process.argv.slice(2);
if (!directoryArgument || process.argv.length > 4)
  throw Error(
    "使い方: bun scripts/fourReversiCalibration.ts <結果ディレクトリ> [予備測定ディレクトリ]",
  );
const root = new URL("..", import.meta.url).pathname;
const directory = resolve(directoryArgument);
const benchmark = join(root, "target/release/tetraboard-ai-benchmark");
const study = join(root, "target/release/study");
const summaryBuild = await Bun.build({
  entrypoints: [join(root, "scripts/fourReversiCalibrationStatistics.ts")],
  target: "bun",
  sourcemap: "none",
});
if (!summaryBuild.success || summaryBuild.outputs.length !== 1)
  throw Error("集計用の実行ファイルを作成できません");
const summaryScript = await summaryBuild.outputs[0]!.arrayBuffer();
const file = (name: string) => join(directory, name);
const stages = [
  { name: "preliminary", seed: 2_000_000, seedCount: 4, seats: 4 },
  { name: "calibration", seed: 3_000_000, seedCount: 32, seats: 24 },
  { name: "evaluation", seed: 4_000_000, seedCount: 32, seats: 24 },
] as const;
const profileIds = profilesFile.profiles.map(({ id }) => id);
const contexts = [profileIds.slice(0, 2), [profileIds[2], profileIds[2]], profileIds.slice(3)];
const pairs = profileIds.flatMap((a, i) =>
  profileIds.slice(i + 1).map((b) => ({
    id: `${a}-${b}`,
    matchups: contexts.map((extra, n) => ({
      id: `${a}-${b}-context-${n}`,
      lineup: [a, b, ...extra],
    })),
  })),
);
const available = availableParallelism();
const processes = Number(process.env.TETRABOARD_CALIBRATION_PROCESSES ?? available);
if (!Number.isInteger(processes) || processes < 1 || processes > available)
  throw Error(`プロセス数は1〜${available}の整数にしてください`);
const maxWallMs = 12 * 60 * 60 * 1000;
const digest = async (path: string) => Bun.CryptoHasher.hash("sha256", await readFile(path), "hex");
const identity = {
  ...(await sourceIdentity(root, [
    "configs/characters-v1.json",
    "fourReversiRating.ts",
    "scripts/fourReversiCalibration.ts",
    "scripts/fourReversiCalibrationStatistics.ts",
    "../../bun.lock",
  ])),
  benchmark: await digest(benchmark),
  study: await digest(study),
  summaryScript: Bun.CryptoHasher.hash("sha256", summaryScript, "hex"),
  environment: {
    os: process.platform,
    release: release(),
    arch: process.arch,
    cpu: cpus()[0]?.model,
    bun: Bun.version,
  },
  profiles: profilesFile.profiles,
  engine: charactersFile.engine_version,
  benchmarkRules: "four-reversi-singles-v1",
  serviceRules: charactersFile.ruleset_version,
  serviceStateVersion: charactersFile.state_version,
  maxWallMs,
  stages,
  pairs,
  resampling: { intervalsSeed: 9_500_000, referenceSeed: 9_500_001 },
};
const writeJson = async (path: string, value: unknown) => {
  await Bun.write(path + ".tmp", JSON.stringify(value, null, 2) + "\n");
  await rename(path + ".tmp", path);
};
await mkdir(directory, { recursive: true });
await mkdir(file(".lock"));
let stopping = false;
const children = new Set<Bun.Subprocess>();
const stop = () => {
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
};
function datasetIdentity(value: typeof identity & { jobs?: number }) {
  // 予備測定と本測定で対局内容を照合し、実行方式の変更後も同じデータを使います。
  const { files, source_hash: _sourceHash, jobs: _jobs, ...inputs } = value;
  const { "scripts/fourReversiCalibration.ts": _scheduler, ...measuredFiles } = files;
  return { ...inputs, files: measuredFiles };
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  const manifestPath = file("manifest.json");
  let importedPreliminary = false;
  if (await Bun.file(manifestPath).exists()) {
    const saved = await Bun.file(manifestPath).json();
    if (
      JSON.stringify(datasetIdentity(saved.identity)) !== JSON.stringify(datasetIdentity(identity))
    )
      throw Error("再開時の測定条件がmanifestと一致しません");
    importedPreliminary = saved.preliminary.logs.length > 0;
  } else {
    let preliminaryMs = 0;
    const logs = [];
    if (preliminaryArgument) {
      const preliminary = resolve(preliminaryArgument);
      const fingerprint = await readFile(join(preliminary, "identity.txt"), "utf8");
      if (!fingerprint.startsWith(identity.benchmark))
        throw Error("予備測定と本測定のBenchmarkが一致しません");
      for (let seed = 2_000_000; seed < 2_000_004; seed++) {
        const path = join(preliminary, `seed-${seed}.jsonl`);
        await readCalibrationUnit(
          path,
          seed,
          pairs.flatMap(({ matchups }) => matchups),
          4,
        );
        logs.push({ seed, path, sha256: await digest(path) });
        const started = Number(await readFile(join(preliminary, `seed-${seed}.started`), "utf8"));
        const finished = Number(await readFile(join(preliminary, `seed-${seed}.finished`), "utf8"));
        if (!(started > 0 && finished > started)) throw Error("予備測定の実行時間が不明です");
        preliminaryMs += (finished - started + 1) * 1000;
      }
      importedPreliminary = true;
    }
    await copyFile(benchmark, file("benchmark"));
    await copyFile(study, file("study"));
    await Bun.write(file("summarize.js"), summaryScript);
    await writeJson(file("progress.json"), { elapsedMs: preliminaryMs, completed: {} });
    await writeJson(manifestPath, {
      version: "four-reversi-lv1-lv5-v1",
      sourceCommit: (await Bun.$`git -C ${root} rev-parse HEAD`.text()).trim(),
      identity,
      preliminary: { elapsedMs: preliminaryMs, logs },
    });
  }
  if (
    (await digest(file("benchmark"))) !== identity.benchmark ||
    (await digest(file("study"))) !== identity.study ||
    (await digest(file("summarize.js"))) !== identity.summaryScript
  )
    throw Error("保存した実行ファイルがmanifestと一致しません");
  const progressPath = file("progress.json");
  const progress = (await Bun.file(progressPath).json()) as {
    elapsedMs: number;
    completed: Record<string, string>;
    active?: string | string[];
  };
  if (progress.active)
    throw Error("前回の強制終了で実行時間を確定できません。progress.jsonを確認してください");
  const active = new Set<string>();
  await appendFile(
    file("execution-log.jsonl"),
    JSON.stringify({
      startedAt: new Date().toISOString(),
      processes,
      jobsPerProcess: 1,
      schedulerHash: identity.files["scripts/fourReversiCalibration.ts"],
      resumedWith: Object.keys(progress.completed).length,
    }) + "\n",
  );

  let lastCheckpoint = performance.now();
  const remaining = maxWallMs - progress.elapsedMs;
  if (remaining <= 0) throw Error("測定時間の上限に達しました");
  const deadline = lastCheckpoint + remaining;
  const timeout = setTimeout(stop, remaining);
  let checkpointQueue = Promise.resolve();
  function checkpoint(update: () => void) {
    const write = checkpointQueue.then(async () => {
      update();
      const now = performance.now();
      // 複数プロセスが同時に動いた時間も、経過した壁時計時間を一度だけ加算します。
      progress.elapsedMs += now - lastCheckpoint;
      lastCheckpoint = now;
      if (active.size) progress.active = [...active];
      else delete progress.active;
      await writeJson(progressPath, progress);
    });
    checkpointQueue = write;
    return write;
  }

  async function runUnit(
    name: string,
    args: string[],
    output: string,
    verify: () => Promise<unknown>,
  ) {
    await checkpoint(() => active.add(name));
    let child: Bun.Subprocess | undefined;
    try {
      if (stopping) throw Error("測定を中断しました");
      child = Bun.spawn(args, { stdout: Bun.file(output), stderr: "inherit" });
      children.add(child);
      if ((await child.exited) !== 0 || stopping) throw Error(`${name} が完了しませんでした`);
      await verify();
      const hash = await digest(output);
      if (performance.now() >= deadline) throw Error("測定時間の上限に達しました");
      await rename(output, file(name));
      await checkpoint(() => {
        progress.completed[name] = hash;
      });
      console.log(JSON.stringify({ unit: name, elapsedMs: progress.elapsedMs }));
    } finally {
      if (child) children.delete(child);
      await checkpoint(() => active.delete(name));
    }
  }

  try {
    for (const stage of stages) {
      if (stage.name === "preliminary" && importedPreliminary) continue;
      const queue = Array.from({ length: stage.seedCount }, (_, i) => stage.seed + i).flatMap(
        (seed) => pairs.map((pair) => ({ seed, pair })),
      );
      let next = 0;
      let failure: unknown;
      async function runPairs() {
        try {
          while (!stopping) {
            const task = queue[next++];
            if (!task) return;
            const { seed, pair } = task;
            const name = `${stage.name}-${seed}-${pair.id}.jsonl`;
            if (progress.completed[name]) {
              if ((await digest(file(name))) !== progress.completed[name])
                throw Error(`${name} が保存済みハッシュと一致しません`);
              continue;
            }
            const config = file(`${name}.config.json`);
            const output = file(`${name}.partial-${Date.now()}`);
            await writeJson(config, {
              format_version: 2,
              seed,
              seat_orders: stage.seats === 4 ? "cyclic" : "all_permutations",
              profiles: profilesFile.profiles.map(({ id, config }) => ({ id, config })),
              matchups: pair.matchups,
            });
            await runUnit(
              name,
              [file("benchmark"), "--config", config, "--rounds", "1", "--jobs", "1"],
              output,
              () => readCalibrationUnit(output, seed, pair.matchups, stage.seats),
            );
          }
        } catch (error) {
          failure ??= error;
          stop();
        }
      }
      await Promise.all(Array.from({ length: processes }, runPairs));
      if (failure) throw failure;
      if (stopping) throw Error("測定を中断しました");
    }
    if (!progress.completed["summary.json"]) {
      const output = file(`summary.json.partial-${Date.now()}`);
      await runUnit(
        "summary.json",
        [process.execPath, file("summarize.js"), directory, file("study")],
        output,
        () => Bun.file(output).json(),
      );
    }
  } finally {
    clearTimeout(timeout);
    await checkpoint(() => {});
  }
} finally {
  await rmdir(file(".lock"));
}
