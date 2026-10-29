import { appendFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { cpus, release, totalmem, loadavg, freemem } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  createStudySearchRuntime,
  type StudySearchOptions,
  type StudySearchSnapshot,
} from "../src/search/runtime";
import {
  efficiencySource,
  prepareEfficiencyInputs,
  verifyEfficiencyRows,
} from "./searchEfficiency";
import { createParallelRecorder } from "./parallelTelemetry";
import type { StudyPositionInput } from "../src/shared/model";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export async function parallelTrial(
  runtime: ReturnType<typeof createStudySearchRuntime>,
  input: StudyPositionInput,
  options: StudySearchOptions,
  maxWork = 20_000_000,
) {
  const started = performance.now(),
    cpu = process.cpuUsage();
  let limitReason: string | null = null,
    settled = false;
  let finish!: (s: StudySearchSnapshot) => void;
  const done = new Promise<StudySearchSnapshot>((r) => {
    finish = r;
  });
  const id = await runtime.start(input, options, (s) => {
    if (s.status === "running" && s.work >= maxWork && !limitReason) {
      limitReason = "work_limit";
      void runtime.cancel(s.id);
    }
    if (!["running", "paused"].includes(s.status) && !settled) {
      settled = true;
      finish(s);
    }
  });
  const startedMs = performance.now() - started;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            void runtime.cancel(id);
            reject(Error("壁時計上限です"));
          },
          (options.timeBudgetMs ?? 1000) + 30000,
        );
      }),
    ]);
    if (snapshot.status === "error") throw Error(snapshot.reason ?? "worker error");
    const used = process.cpuUsage(cpu);
    return {
      startedMs,
      responseMs: performance.now() - started,
      parentCpuMs: (used.user + used.system) / 1000,
      limitReason,
      snapshot: runtime.get(id) ?? snapshot,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runParallelProbe(directory: string) {
  const source = efficiencySource(),
    fingerprint = sha(JSON.stringify(source)),
    begin = performance.now();
  const inputs = await Bun.file(join(directory, "private-inputs/inputs.json")).json();
  const file = join(directory, "baseline/probe.jsonl");
  if (await Bun.file(file).exists()) throw Error("既存の測定を上書きしません");
  const header = {
    kind: "header",
    phase: "probe",
    source,
    startedAt: new Date().toISOString(),
    environment: {
      bun: Bun.version,
      os: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    limits: {
      maxMinutes: 12,
      workers: 8,
      memoryMiB: 8192,
      maxWork: 20_000_000,
      totalMeasurementMinutes: 220,
    },
    contract: {
      cold: "new runtime and child processes; parent process may already be warm",
      warm: "same runtime after a separate 100ms search",
      logicalIpcBytes: true,
      privateReplayAndPV: "local only",
      indices: [0, 2, 5, 15],
      warmIndices: [2],
    },
  };
  await writeFile(file, JSON.stringify(header) + "\n");
  let count = 0;
  const progress = {
    complete: false,
    sourceUnchanged: true,
    failure: null as string | null,
    rows: 0,
    elapsedMs: 0,
  };
  async function save() {
    progress.elapsedMs = performance.now() - begin;
    progress.sourceUnchanged = sha(JSON.stringify(efficiencySource())) === fingerprint;
    await writeFile(
      join(directory, "diagnostics/probe-status.json"),
      JSON.stringify(progress) + "\n",
    );
  }
  try {
    for (const budget of [500, 2000, 5000, 20000])
      for (const index of [0, 2, 5, 15])
        for (const threads of [1, 2, 4, 8].map((_, offset) => [1, 2, 4, 8][(index + offset) % 4]))
          for (const thermal of ["cold", "warm"] as const) {
            if (thermal === "warm" && index !== 2) continue;
            if (performance.now() - begin > 12 * 60000) throw Error("probe phaseの時間上限です");
            if (sha(JSON.stringify(efficiencySource())) !== fingerprint)
              throw Error("ソース変更を検出しました");
            const recorder = createParallelRecorder(threads),
              runtime = createStudySearchRuntime({
                threads,
                memoryMb: 8192,
                measureStages: true,
                observeParallel: recorder.observe,
              });
            try {
              const options = { strategy: "dual-continuations" as const, timeBudgetMs: budget };
              if (thermal === "warm")
                await parallelTrial(runtime, inputs[index].input, {
                  ...options,
                  timeBudgetMs: 100,
                });
              const result = await parallelTrial(runtime, inputs[index].input, options);
              const parallel = recorder.summarize(result.snapshot.id);
              const row = {
                kind: "search",
                id: inputs[index].id,
                inputSha256: sha(JSON.stringify(inputs[index].input)),
                strategy: options.strategy,
                variant: "root",
                threads,
                budget,
                thermal,
                system: {
                  loadAverage: loadavg(),
                  freeMemoryBytes: freemem(),
                  parentRss: process.memoryUsage.rss(),
                },
                result,
                parallel,
              };
              await appendFile(file, JSON.stringify(row) + "\n");
              progress.rows = ++count;
              await save();
              console.log(
                JSON.stringify({
                  count,
                  budget,
                  threads,
                  thermal,
                  id: row.id,
                  depth: result.snapshot.completedDepth,
                  deepActiveShare: parallel.phases.deep.sampledActiveShare,
                  deepConcurrent: parallel.phases.deep.averageConcurrent,
                  reason: result.snapshot.reason,
                }),
              );
            } finally {
              await runtime.close();
            }
          }
    progress.complete = true;
  } catch (e) {
    progress.failure = String(e);
    throw e;
  } finally {
    await save();
    await appendFile(file, JSON.stringify({ kind: "footer", ...progress }) + "\n");
  }
}
export async function verifyParallelFile(directory: string, file: string) {
  const inputs = await Bun.file(join(directory, "private-inputs/inputs.json")).json();
  let searches = 0,
    candidates = 0;
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    const row = JSON.parse(line);
    if (row.kind !== "search") continue;
    const result = await verifyEfficiencyRows([row], inputs);
    searches += result.searches;
    candidates += result.candidates;
  }
  return { allMatch: true, searches, candidates };
}
if (import.meta.main) {
  const args = new Map(
    Bun.argv.slice(2).map((a) => {
      const m = /^--([a-z-]+)=(.+)$/.exec(a);
      if (!m) throw Error("--key=value形式で指定してください");
      return [m[1], m[2]];
    }),
  );
  const directory = resolve(args.get("directory") ?? "");
  if (!args.get("directory")) throw Error("Git管理外の保存先を指定してください");
  if (args.get("mode") === "prepare")
    console.log(
      JSON.stringify({ inputs: (await prepareEfficiencyInputs(directory, 9802000)).length }),
    );
  else if (args.get("mode") === "verify")
    console.log(
      JSON.stringify(
        await verifyParallelFile(
          directory,
          args.get("file") ?? join(directory, "baseline/probe.jsonl"),
        ),
      ),
    );
  else await runParallelProbe(directory);
}
