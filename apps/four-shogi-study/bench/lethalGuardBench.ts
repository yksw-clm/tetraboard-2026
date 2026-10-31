import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { cpus, totalmem, release } from "node:os";
import { git, repoRoot, sourceIdentity } from "../../../packages/four-shogi/bench/baseline";
import { hashJson } from "../../../packages/four-shogi/bench/singlesMeasurement";
import type { LossCase } from "./lossAnalysisCases";

export const guardBenchIdentity = () => ({
  commit: git("rev-parse", "HEAD"),
  core: sourceIdentity(resolve(repoRoot, "packages/four-shogi/src")).sha256,
  app: sourceIdentity(resolve(repoRoot, "apps/four-shogi-study/src")).sha256,
  bench: sourceIdentity(resolve(repoRoot, "apps/four-shogi-study/bench")).sha256,
  fixtures: sourceIdentity(resolve(repoRoot, "packages/four-shogi/bench")).sha256,
});
const read = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const save = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
export function prepareGuardBench(directory: string, oldDirectory: string) {
  if (git("status", "--porcelain")) throw Error("コミット済みの固定ソースが必要です");
  if (existsSync(directory)) throw Error("既存成果物を上書きしません");
  for (const name of [
    "inputs",
    "baseline",
    "observe",
    "experimental",
    "proofs",
    "diagnostics",
    "validation",
    "upload",
  ])
    mkdirSync(join(directory, name), { recursive: true });
  const prior = read<{ cases: { id: string; caseHash: string }[] }>(
    join(oldDirectory, "plan.json"),
  );
  const cases = prior.cases.map((item) => {
    const file = join(oldDirectory, "cases", item.id + ".json");
    const c = read<LossCase>(file);
    if (hashJson(c) !== item.caseHash) throw Error("既存入力のhash不一致");
    copyFileSync(file, join(directory, "inputs", item.id + ".json"));
    return { id: c.id, gameId: c.gameId, kind: c.kind, role: c.role, caseHash: item.caseHash };
  });
  copyFileSync(
    resolve(repoRoot, "docs/four-shogi-study-p1-4b-loss-summary.json"),
    join(directory, "input-summary.json"),
  );
  const mandatory = ["ae960d72d889183a-95", "f1c8fdef9f37da03-146"];
  const warm = [
    ...mandatory,
    ...cases.filter((c) => c.kind === "win-control").map((c) => c.id),
    ...cases
      .filter((c) => c.kind === "loss" && c.role === "last" && !mandatory.includes(c.id))
      .slice(0, 4)
      .map((c) => c.id),
  ];
  const plan = {
    schemaVersion: 1,
    id: directory.split("/").at(-1),
    registeredAt: new Date().toISOString(),
    source: guardBenchIdentity(),
    reference: "8943d70e065f5a5a0fcc32cd635c9aa83f75ab8d",
    cases,
    warm,
    environment: {
      bun: Bun.version,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      os: release(),
    },
    limits: {
      wallMinutes: 90,
      mainMinutes: 50,
      qualityMinutes: 25,
      workers: 4,
      maxWorkers: 8,
      softRssMiB: 6144,
      hardRssMiB: 7168,
      caseSeconds: 90,
      storageMiB: 512,
    },
    conditions: {
      totalMs: 2000,
      broadDepth: 3,
      budgetsMs: [100, 250, 400],
      selections: ["top3", "top5", "top3-reserve", "all"],
      primarySelection: "top3-reserve",
      horizon: 4,
      transitions: 5000,
      work: 100000,
      proofBytes: 16 * 1024 * 1024,
      cold: "fresh runtime and worker processes per condition",
      warm: "same runtime prewarmed at completed depth1; repeated input, fresh search context",
      phaseOrder:
        "cold36 then preregistered warm12; per-case condition order rotated by case index",
      matrix: [
        "v5-off-2000",
        "p05-off-2000",
        ...[100, 250, 400].flatMap((ms) => [
          `p05-short-${ms}`,
          `p05-observe-${ms}`,
          `p05-experimental-${ms}`,
        ]),
      ],
      controls:
        "OFF-short has same wall/startup/broadDepth as guard's MaxN phase; frozen-result policy ablations use extra diagnostic time and are not equal-2s strength comparisons",
      rootPolicy:
        "incumbent->static rank2 reserves->other top3; per-query half of guard budget; exact same horizon/hash/root proof only; unknown is not unsafe",
      quality: {
        pastMs: 1000,
        pastStrategies: ["adaptive", "dual-continuations"],
        newMs: 2000,
        newConditions: [
          "v5-off",
          "p05-off",
          "p05-observe-250",
          "p05-experimental-250",
          "p05-experimental-400",
        ],
        cases: 88,
        critical: 40,
        knownFixed: 8,
        depth: 9,
      },
      compatibility:
        "old8943 runtime vs new OFF, 1worker/maxDepth2, source core old files byte identical; normalize only timing/memory/id",
    },
    noNewGames: true,
    noNewSeeds: true,
    noDefaultChange: true,
    noCoefficientChange: true,
  };
  save(join(directory, "plan.json"), plan);
  return plan;
}

async function run(directory: string) {
  const plan = read<ReturnType<typeof prepareGuardBench>>(join(directory, "plan.json"));
  if (hashJson(plan.source) !== hashJson(guardBenchIdentity())) throw Error("計測ソース不一致");
  let stopped = false,
    child: ReturnType<typeof spawn> | null = null;
  const started = performance.now();
  const stop = () => {
    stopped = true;
    child?.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const guard = spawn(
    "python3",
    [
      join(import.meta.dir, "lethalGuardResourceGuard.py"),
      "--pid",
      String(process.pid),
      "--directory",
      directory,
      "--wall-seconds",
      String(
        Math.max(
          1,
          Math.floor(
            Math.min(50 * 60, 90 * 60 - (Date.now() - Date.parse(plan.registeredAt)) / 1000),
          ),
        ),
      ),
    ],
    { stdio: "ignore" },
  );
  const jobs = [
    ...plan.cases.map((c, i) => ({ id: c.id, warm: false, index: i })),
    ...plan.warm.map((id, i) => ({ id, warm: true, index: i })),
  ];
  const completed: unknown[] = [],
    failures: unknown[] = [];
  try {
    for (const job of jobs) {
      if (stopped || performance.now() - started >= 50 * 60000) break;
      let size = 0;
      const bytes = (dir: string) => {
        for (const n of readdirSync(dir)) {
          const p = join(dir, n),
            s = statSync(p);
          if (s.isDirectory()) bytes(p);
          else size += s.size;
        }
      };
      bytes(directory);
      if (size > 512 * 1024 * 1024) throw Error("保存容量上限です");
      const args = [
        join(import.meta.dir, "lethalGuardCase.ts"),
        directory,
        job.id,
        job.warm ? "warm" : "cold",
        String(job.index),
      ];
      child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const pid = child.pid!;
      let tail = "";
      child.stdout!.on("data", (data) => {
        const t = String(data);
        process.stdout.write(t);
      });
      child.stderr!.on("data", (data) => {
        tail = (tail + String(data)).slice(-4000);
      });
      const timeout = setTimeout(() => {
        child?.kill("SIGTERM");
      }, plan.limits.caseSeconds * 1000);
      const kill = setTimeout(
        () => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        },
        (plan.limits.caseSeconds + 5) * 1000,
      );
      const code = await new Promise<number | null>((r) => child!.once("exit", r));
      clearTimeout(timeout);
      clearTimeout(kill);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
      child = null;
      if (code === 0) completed.push(job);
      else failures.push({ ...job, code, error: tail.replaceAll(directory, "<ARTIFACT_ROOT>") });
      save(join(directory, "checkpoint.json"), {
        completed,
        failures,
        elapsedMs: performance.now() - started,
        sourceUnchanged: hashJson(plan.source) === hashJson(guardBenchIdentity()),
        stopped,
      });
      if (code !== 0) break;
    }
  } finally {
    guard.kill("SIGTERM");
    child?.kill("SIGTERM");
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return { completed: completed.length, failures: failures.length };
}

if (import.meta.main) {
  const [mode, dir, old] = Bun.argv.slice(2);
  if (mode === "prepare")
    console.log(JSON.stringify(prepareGuardBench(resolve(dir), resolve(old))));
  else if (mode === "run") console.log(JSON.stringify(await run(resolve(dir))));
  else throw Error("prepare|run <directory> [P1-4b directory]");
}
