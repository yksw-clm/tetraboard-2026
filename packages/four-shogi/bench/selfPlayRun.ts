import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git, repoRoot, sourceIdentity, loadPlayer } from "./baseline";
import { SelfPlayStore } from "./selfPlayStore";
import { GenerationPaused, configInput } from "./selfPlayGame";
import { inspectDataStore } from "./selfPlayInspect";
import {
  createDataManifest,
  defaultSelfPlayConfig,
  parseSelfPlayConfig,
  gamePlans,
  sameData,
  dataInteger,
  type DataCode,
  type DataManifest,
  type GameArtifact,
  type GamePlan,
} from "./selfPlayData";

export type GenerationLimits = {
  concurrency: number;
  maxGames: number;
  maxBytes: number;
  maxRssBytes: number;
  maxRunMs: number;
  stopAfterMoves: number | null;
  allowDirty: boolean;
};
export type GenerationControl = {
  signal?: AbortSignal;
  readRss?: (pids: number[]) => number;
  onCommit?: (record: GameArtifact) => void;
};
export type GenerationReport = Awaited<ReturnType<typeof inspectDataStore>> & {
  status: "paused" | "completed";
  stopReason: string | null;
  limits: GenerationLimits;
  observed: {
    peakWorkers: number;
    maxRssBytes: number;
    rssSamplingMs: number;
    elapsedMs: number;
    committedMoves: number;
    teacherPositions: number;
  };
  throughput: {
    positionsPerSecond: number;
    teacherPositionsPerSecond: number;
    completedRecordsPerHour: number;
    naturallyFinishedPerHour: number;
    bytesPerPolicySample: number | null;
    estimate100kPolicySamplesBytes: number | null;
  };
};
export function resolveGenerationLimits(input: Partial<GenerationLimits> = {}): GenerationLimits {
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "concurrency",
          "maxGames",
          "maxBytes",
          "maxRssBytes",
          "maxRunMs",
          "stopAfterMoves",
          "allowDirty",
        ].includes(key),
    )
  )
    throw new TypeError("未知の資源制限です");
  const limits = {
    concurrency: 1,
    maxGames: 64,
    maxBytes: 256 * 1024 ** 2,
    maxRssBytes: 1024 ** 3,
    maxRunMs: 30 * 60 * 1000,
    stopAfterMoves: null,
    allowDirty: false,
    ...input,
  };
  dataInteger(limits.concurrency, 1, 4);
  dataInteger(limits.maxGames, 1, 4096);
  dataInteger(limits.maxBytes, 1, 1024 ** 4);
  dataInteger(limits.maxRssBytes, 64 * 1024 ** 2, 64 * 1024 ** 3);
  dataInteger(limits.maxRunMs, 1, 24 * 60 * 60 * 1000);
  if (limits.stopAfterMoves !== null)
    dataInteger(limits.stopAfterMoves, 0, Number.MAX_SAFE_INTEGER);
  if (typeof limits.allowDirty !== "boolean") throw new TypeError("dirty状態の許可はbooleanです");
  return limits;
}
export function currentDataCode(): DataCode {
  return {
    commit: git("rev-parse", "HEAD"),
    dirty:
      git(
        "status",
        "--porcelain",
        "--",
        "packages/four-shogi/src",
        "packages/four-shogi/bench",
        "packages/four-shogi/package.json",
      ).length > 0,
    sourceHash: sourceIdentity(join(repoRoot, "packages/four-shogi/src")).sha256,
    runnerHash: sourceIdentity(join(repoRoot, "packages/four-shogi/bench")).sha256,
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
  };
}
export function compatibleDataCode(current: DataCode, saved: DataCode) {
  if (
    current.sourceHash !== saved.sourceHash ||
    current.runnerHash !== saved.runnerHash ||
    !sameData(current.runtime, saved.runtime)
  )
    throw new Error("再開元とコード/ランタイムが異なります。別datasetを作成してください");
}
async function prepareManifest(input: unknown, code: DataCode, temporaryDirectory: string) {
  const config = parseSelfPlayConfig(input, code);
  const cpuSources: DataManifest["cpuSources"] = {};
  for (const agent of config.agents)
    if (agent.kind === "cpu") {
      const player = await loadPlayer(agent.reference, {}, { temporaryDirectory });
      try {
        cpuSources[agent.id] = player.metadata;
      } finally {
        player.dispose();
      }
    }
  return createDataManifest(input, code, cpuSources);
}
export function processRss(pids: number[]): number {
  let total = process.memoryUsage().rss;
  if (!pids.length) return total;
  if (process.platform === "linux") {
    for (const pid of pids) {
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        total += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } else if (process.platform === "darwin") {
    const sample = Bun.spawnSync(["ps", "-o", "rss=", "-p", pids.join(",")]);
    if (sample.exitCode !== 0 && sample.exitCode !== 1)
      throw new Error("子プロセスのRSSを取得できません");
    for (const value of sample.stdout.toString().trim().split(/\s+/))
      if (value) total += Number(value) * 1024;
  } else throw new Error("生成のRSS監視はmacOS/Linuxに対応しています");
  if (!Number.isFinite(total)) throw new Error("RSS取得結果が不正です");
  return total;
}

export async function runSelfPlayDataset(
  directory: string,
  input: unknown = undefined,
  options: Partial<GenerationLimits> = {},
  control: GenerationControl = {},
): Promise<GenerationReport> {
  const limits = resolveGenerationLimits(options);
  const code = currentDataCode();
  if (code.dirty && !limits.allowDirty)
    throw new Error(
      "生成コードに未コミット変更があります。実験時だけallow-dirtyを明示してください",
    );
  const store = new SelfPlayStore(directory, limits.maxBytes);
  const started = performance.now();
  let committedMoves = 0;
  let teacherPositions = 0;
  let reason: string | null = null;
  let fatal: Error | null = null;
  let maxRssBytes = 0;
  let peakWorkers = 0;
  let writeQueue = Promise.resolve();
  const active = new Map<number, Bun.Subprocess>();
  const readRss = control.readRss ?? processRss;
  let timer: ReturnType<typeof setInterval> | undefined;
  function pause(why: string) {
    reason ??= why;
    for (const child of active.values()) child.kill();
  }
  const cancel = () => pause("cancelled");
  function resources() {
    const rss = readRss([...active.keys()]);
    if (!Number.isFinite(rss) || rss < 0) throw new Error("RSSが不正です");
    maxRssBytes = Math.max(maxRssBytes, rss);
    if (rss > limits.maxRssBytes) pause("memory_limit");
    if (performance.now() - started >= limits.maxRunMs) pause("time_limit");
  }
  try {
    control.signal?.addEventListener("abort", cancel, { once: true });
    const previous = store.readManifest();
    if (previous) compatibleDataCode(code, previous.code);
    const actualInput =
      input ?? (previous ? configInput(previous.config) : defaultSelfPlayConfig());
    const manifest = await prepareManifest(
      actualInput,
      previous?.code ?? code,
      store.scratchDirectory,
    );
    if (previous && !sameData(previous, manifest))
      throw new Error("再開元と系列/相手/予算/教師/分割/版が不一致です");
    const plans = gamePlans(manifest);
    if (plans.length > limits.maxGames) throw new Error("計画件数がmax-gamesを超えています");
    if (!previous) store.writeManifest(manifest);
    const allowed = new Map(plans.map((p) => [p.gameId, p]));
    for (const id of store.gameIds())
      if (!allowed.has(id)) throw new Error("未知/重複のゲームファイルがあります");
    const pending = plans.filter((plan) => {
      const saved = store.readGame(plan.gameId);
      if (saved && (saved.datasetId !== manifest.datasetId || !sameData(saved.plan, plan)))
        throw new Error("ゲームの設定が混在しています");
      return !saved || saved.status === "in_progress";
    });
    const initiallyComplete = plans.length - pending.length;
    const initiallyFinished = plans.filter(
      (p) => store.readGame(p.gameId)?.status === "finished",
    ).length;
    resources();
    if (control.signal?.aborted) pause("cancelled");
    if (limits.stopAfterMoves === 0) pause("move_limit");
    timer = setInterval(() => {
      try {
        resources();
      } catch (error) {
        fatal = error as Error;
        pause("error");
      }
    }, 250);
    let cursor = 0;
    async function run(plan: GamePlan) {
      const scratch = mkdtempSync(join(store.scratchDirectory, "worker-"));
      const saved = store.readGame(plan.gameId);
      let priorMoves = saved?.actors.length ?? 0;
      let priorSamples = saved?.samples.length ?? 0;
      let initialized = saved !== null;
      let childError: string | null = null;
      const child = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, "selfPlayWorker.ts")],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        serialization: "json",
        ipc(message, subprocess) {
          if (message?.type === "checkpoint") {
            const request = message as { type: string; record: GameArtifact; ticket: number };
            const operation = writeQueue.then(() => {
              if (reason) throw new GenerationPaused(reason);
              resources();
              if (reason) throw new GenerationPaused(reason);
              const record = request.record;
              const delta = record.actors.length - priorMoves;
              if (
                record.datasetId !== manifest.datasetId ||
                !sameData(record.plan, plan) ||
                (!initialized && delta !== 0) ||
                (initialized && delta !== 1)
              )
                throw new Error("重複/欠落したcheckpointです");
              store.writeGame(record);
              initialized = true;
              priorMoves = record.actors.length;
              committedMoves += delta;
              teacherPositions += record.samples.length - priorSamples;
              priorSamples = record.samples.length;
              control.onCommit?.(record);
              if (limits.stopAfterMoves !== null && committedMoves >= limits.stopAfterMoves)
                reason = "move_limit";
            });
            writeQueue = operation.catch((error) => {
              if (error instanceof GenerationPaused) reason ??= error.message;
              else {
                fatal = error as Error;
                reason ??= "error";
              }
            });
            void operation
              .then(
                () => {
                  if (reason) pause(reason);
                  else subprocess.send({ type: "ack", ticket: request.ticket });
                },
                () => pause(reason ?? "error"),
              )
              .catch((error) => {
                fatal = error as Error;
                pause("error");
              });
          } else if (message?.type === "error") childError = String(message.message);
        },
      });
      active.set(child.pid, child);
      peakWorkers = Math.max(peakWorkers, active.size);
      const stderr = new Response(child.stderr).text();
      child.send({ type: "start", manifest, plan, saved, scratch });
      const exit = await child.exited;
      active.delete(child.pid);
      const output = await stderr;
      rmSync(scratch, { recursive: true, force: true });
      if (exit !== 0 && !reason) {
        fatal = new Error(
          childError ?? (output.slice(-4000) || `生成workerが終了しました: ${exit}`),
        );
        pause("error");
      }
    }
    await Promise.all(
      Array.from({ length: limits.concurrency }, async () => {
        while (!reason && cursor < pending.length) {
          const plan = pending[cursor++];
          await run(plan);
        }
      }),
    );
    await writeQueue;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (fatal) throw fatal;
    compatibleDataCode(currentDataCode(), manifest.code);
    const summary = await inspectDataStore(store);
    const elapsedMs = performance.now() - started;
    const accepted = Math.max(0, committedMoves);
    resources();
    return {
      ...summary,
      status: reason ? "paused" : "completed",
      stopReason: reason,
      limits,
      observed: {
        peakWorkers,
        maxRssBytes,
        rssSamplingMs: 250,
        elapsedMs,
        committedMoves: accepted,
        teacherPositions,
      },
      throughput: {
        positionsPerSecond: (accepted * 1000) / elapsedMs,
        teacherPositionsPerSecond: (teacherPositions * 1000) / elapsedMs,
        completedRecordsPerHour:
          ((summary.finished + summary.truncated - initiallyComplete) * 3600000) / elapsedMs,
        naturallyFinishedPerHour: ((summary.finished - initiallyFinished) * 3600000) / elapsedMs,
        bytesPerPolicySample: summary.policySamples
          ? summary.logicalBytes / summary.policySamples
          : null,
        estimate100kPolicySamplesBytes: summary.policySamples
          ? Math.ceil((summary.logicalBytes / summary.policySamples) * 100000)
          : null,
      },
    };
  } finally {
    if (timer) clearInterval(timer);
    control.signal?.removeEventListener("abort", cancel);
    for (const child of active.values()) child.kill();
    await Promise.all([...active.values()].map((c) => c.exited));
    await writeQueue;
    store.close();
  }
}
